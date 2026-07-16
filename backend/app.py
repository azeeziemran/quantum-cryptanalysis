import json
import os
from collections import defaultdict, deque
from datetime import datetime, timezone
from threading import Lock
from time import monotonic

from flask import Flask, jsonify, request
from flask_socketio import SocketIO, emit

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1_000_000

DEFAULT_ALLOWED_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
ALLOWED_ORIGINS = {
    origin.strip()
    for origin in os.environ.get("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).split(",")
    if origin.strip()
}

socketio = SocketIO(
    app,
    cors_allowed_origins=list(ALLOWED_ORIGINS),
    async_mode="threading",
    max_http_buffer_size=1_000_000,
)

users = []
messages = []
rate_limit_buckets = defaultdict(deque)
rate_limit_lock = Lock()

RATE_LIMIT_WINDOW_SECONDS = 10
RATE_LIMIT_MAX_ACTIONS = 30


@app.route("/")
def home():
    return "Quantum backend running!"


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "Request body is too large"}), 413


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin")
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        response.headers.add("Vary", "Origin")
    return response


def clean_name(value):
    return " ".join((value or "").split())


def client_identifier():
    socket_id = getattr(request, "sid", None)
    if socket_id:
        return socket_id

    forwarded_address = request.headers.get("CF-Connecting-IP")
    if not forwarded_address:
        forwarded_address = request.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()

    return forwarded_address or request.remote_addr or "unknown"


def rate_limit_exceeded(action):
    now = monotonic()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS
    bucket_key = (action, client_identifier())

    with rate_limit_lock:
        bucket = rate_limit_buckets[bucket_key]
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()

        if len(bucket) >= RATE_LIMIT_MAX_ACTIONS:
            return True

        bucket.append(now)
        return False


def valid_public_key(public_key):
    if not isinstance(public_key, dict):
        return False

    return isinstance(public_key.get("x"), int) and isinstance(public_key.get("y"), int)


def same_public_key(first, second):
    return (
        isinstance(first, dict)
        and isinstance(second, dict)
        and first.get("x") == second.get("x")
        and first.get("y") == second.get("y")
    )


def register_user(data):
    name = clean_name(data.get("name"))
    public_key = data.get("publicKey")
    signing_public_key = data.get("signingPublicKey")

    if len(name.split()) < 2:
        return None, "Full name is required"

    if not valid_public_key(public_key):
        return None, "ECC public key is required"

    if not valid_public_key(signing_public_key):
        return None, "Signing public key is required"

    for user in users:
        if (
            user["name"] == name
            and same_public_key(user["publicKey"], public_key)
            and same_public_key(user["signingPublicKey"], signing_public_key)
        ):
            return user, None

    user = {
        "id": len(users) + 1,
        "name": name,
        "publicKey": public_key,
        "signingPublicKey": signing_public_key,
        "joinedAt": datetime.now(timezone.utc).isoformat(),
    }
    users.append(user)
    return user, None


def store_message(data):
    sender_id = data.get("senderId")
    sender_name = clean_name(data.get("senderName"))
    sender_public_key = data.get("senderPublicKey")
    sender_signing_public_key = data.get("senderSigningPublicKey")
    payloads = data.get("payloads")
    signature = data.get("signature")

    if not isinstance(sender_id, int):
        return None, "Sender ID is required"

    if len(sender_name.split()) < 2:
        return None, "Full sender name is required"

    if not valid_public_key(sender_public_key):
        return None, "Sender public key is required"

    if not valid_public_key(sender_signing_public_key):
        return None, "Sender signing public key is required"

    if not isinstance(payloads, list) or not payloads:
        return None, "Ciphertext payloads are required"

    if not isinstance(signature, dict):
        return None, "Encrypted envelope signature is required"

    for payload in payloads:
        if not isinstance(payload, dict):
            return None, "Invalid ciphertext payload"
        if not isinstance(payload.get("recipientId"), int):
            return None, "Ciphertext payload recipient is required"
        if "recipientPublicKey" in payload and not valid_public_key(payload.get("recipientPublicKey")):
            return None, "Recipient public key must be a valid ECC point"
        if not isinstance(payload.get("iv"), str) or not isinstance(payload.get("ciphertext"), str):
            return None, "Ciphertext and IV are required"
        if payload.get("algorithm") != "AES-GCM":
            return None, "AES-GCM payload algorithm is required"
        if payload.get("kdf") != "SHA-256(sharedSecret)":
            return None, "SHA-256 KDF label is required"

    message = {
        "id": len(messages) + 1,
        "senderId": sender_id,
        "senderName": sender_name,
        "senderPublicKey": sender_public_key,
        "senderSigningPublicKey": sender_signing_public_key,
        "payloads": payloads,
        "signature": signature,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }

    encrypted_log = {
        "id": message["id"],
        "senderId": message["senderId"],
        "senderName": message["senderName"],
        "senderPublicKey": message["senderPublicKey"],
        "senderSigningPublicKey": message["senderSigningPublicKey"],
        "payloads": message["payloads"],
        "signature": message["signature"],
        "createdAt": message["createdAt"],
    }

    print("\n===== ENCRYPTED MESSAGE =====", flush=True)
    print(json.dumps(encrypted_log, indent=2), flush=True)
    print("===== END ENCRYPTED MESSAGE =====\n", flush=True)

    messages.append(message)
    return message, None


@app.route("/users", methods=["GET", "POST", "OPTIONS"])
def chat_users():
    if request.method == "OPTIONS":
        return ("", 204)

    if request.method == "GET":
        return jsonify(users)

    if rate_limit_exceeded("register_user"):
        return jsonify({"error": "Too many registration requests"}), 429

    user, error = register_user(request.get_json(silent=True) or {})
    if error:
        return jsonify({"error": error}), 400

    socketio.emit("users_updated", users)
    return jsonify(user), 201


@app.route("/messages", methods=["GET", "POST", "OPTIONS"])
def chat_messages():
    if request.method == "OPTIONS":
        return ("", 204)

    if request.method == "GET":
        return jsonify(messages[-100:])

    if rate_limit_exceeded("send_message"):
        return jsonify({"error": "Too many messages; wait before trying again"}), 429

    message, error = store_message(request.get_json(silent=True) or {})
    if error:
        return jsonify({"error": error}), 400

    socketio.emit("message_created", message)
    return jsonify(message), 201


@socketio.on("connect")
def socket_connected():
    emit("users_updated", users)
    emit("messages_snapshot", messages[-100:])


@socketio.on("join_chat")
def socket_join_chat(data):
    if rate_limit_exceeded("register_user"):
        return {"ok": False, "error": "Too many registration requests"}

    user, error = register_user(data or {})
    if error:
        return {"ok": False, "error": error}

    socketio.emit("users_updated", users)
    emit("messages_snapshot", messages[-100:])
    return {"ok": True, "user": user}


@socketio.on("send_encrypted_message")
def socket_send_encrypted_message(data):
    if rate_limit_exceeded("send_message"):
        return {"ok": False, "error": "Too many messages; wait before trying again"}

    message, error = store_message(data or {})
    if error:
        return {"ok": False, "error": error}

    socketio.emit("message_created", message)
    return {"ok": True, "message": message}


if __name__ == "__main__":
    socketio.run(
        app,
        host="0.0.0.0",
        port=7070,
        debug=False,
        use_reloader=False,
    )
