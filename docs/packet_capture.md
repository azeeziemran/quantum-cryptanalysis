# Packet Capture Workflow

Use this only on systems you own or are authorized to inspect.

The capture point is not the Cloudflare Tunnel connection itself. Cloudflare Tunnel delivers traffic to the frontend container, and nginx proxies `/socket.io/` and `/api/` traffic to `backend:7070`. Captures on port `7070` show that internal frontend-to-backend traffic.

## Capture

Container-level capture:

```bash
mkdir -p captures
docker compose exec backend sh -c 'umask 077; tcpdump -i any -s 0 -w /tmp/quantum-chat-local.pcap port 7070'
docker compose cp backend:/tmp/quantum-chat-local.pcap captures/quantum-chat-local.pcap
```

Host-level capture, if port `7070` is visible from the host network namespace:

```bash
mkdir -p ~/quantum-chat-captures
sudo tcpdump -i any port 7070 -w ~/quantum-chat-captures/chat.pcap
```

Remote download example:

```bash
mkdir -p ./captures
scp USER@SERVER:~/quantum-chat-captures/chat.pcap ./captures/chat.pcap
```

## Inspect

Open the `.pcap` in Wireshark and start with:

```text
tcp.port == 7070
```

Use `websocket` for upgraded Socket.IO traffic, or `http` if Socket.IO is still using polling. Find the encrypted message envelope, right-click the payload value, choose `Copy` -> `Value`, and paste it into `shor_payload_decryption.ipynb`.

Backend logs also print encrypted envelopes:

```bash
docker compose logs -f backend
docker compose -f compose.prod.yml logs -f backend
```
