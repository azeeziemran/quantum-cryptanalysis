# Quantum Chat Deployment

The production deployment uses two immutable application images from GitHub Container Registry and a pinned Cloudflare Tunnel container. Only `cloudflared` reaches the public network; the frontend and backend expose no host ports.

## 1. GitHub repository settings

Create a GitHub repository and push this project. If the repository is public, keep pull-request CI on GitHub-hosted runners and reserve any self-hosted runner for trusted deployment workflows only. Then create a GitHub environment named `production`.

Add these environment secrets:

- `DEPLOY_HOST`: server hostname or IP address.
- `DEPLOY_USER`: unprivileged SSH user that can run Docker.
- `DEPLOY_SSH_KEY`: private SSH key used only for deployment.
- `DEPLOY_KNOWN_HOSTS`: the server's verified SSH host-key line. Generate it with `ssh-keyscan`, but verify its fingerprint through a separate trusted channel before saving it.

Add these optional environment variables:

- `DEPLOY_PORT`: SSH port; defaults to `22`.
- `DEPLOY_PATH`: deployment directory relative to the SSH user's home; defaults to `quantum-chat`.

The CI workflow validates the frontend, backend, Compose files, and Docker builds. After CI succeeds on `main`, the deployment workflow publishes multi-platform images tagged with the tested commit SHA and deploys that exact SHA.

## 2. One-time server setup

Install Docker Engine with the Compose plugin. Add the deployment user to the Docker group or otherwise permit it to run Docker.

Authenticate once to the private GitHub Container Registry using a GitHub token with read-only package access:

```bash
echo "YOUR_READ_ONLY_GHCR_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Create the deployment directory and its secret environment file:

```bash
mkdir -p ~/quantum-chat
cd ~/quantum-chat
umask 077
cat > .env
```

Enter the tunnel token and production origin, then press `Ctrl-D`:

```dotenv
CLOUDFLARED_TOKEN=replace_with_the_real_token
ALLOWED_ORIGINS=https://chat.example.com
```

The Cloudflare Tunnel public hostname, for example `https://chat.example.com`, must route to this internal service:

```text
http://frontend:5173
```

No inbound application ports need to be opened because Cloudflare Tunnel establishes an outbound connection.

## 3. Normal deployment

Push or merge a commit to `main`. After CI passes, GitHub publishes both images and updates the server automatically.

Check the deployment on the server:

```bash
cd ~/quantum-chat
docker compose -f compose.prod.yml ps
docker compose -f compose.prod.yml logs -f
```

## 4. Rollback

Find a previously published commit SHA and run:

```bash
cd ~/quantum-chat
IMAGE_BASE=ghcr.io/YOUR_GITHUB_USER/YOUR_REPOSITORY \
IMAGE_TAG=PREVIOUS_COMMIT_SHA \
docker compose -f compose.prod.yml pull

IMAGE_BASE=ghcr.io/YOUR_GITHUB_USER/YOUR_REPOSITORY \
IMAGE_TAG=PREVIOUS_COMMIT_SHA \
docker compose -f compose.prod.yml up -d
```

## 5. Authorized packet capture

Capture backend HTTP traffic containing the application-level ciphertext:

```bash
cd ~/quantum-chat
docker compose -f compose.prod.yml exec backend \
  sh -c 'umask 077; tcpdump -i any -s 0 -w /tmp/quantum-chat.pcap port 7070'
```

Stop with `Ctrl-C`, copy the capture to the server, and download it to your Mac:

```bash
docker compose -f compose.prod.yml cp backend:/tmp/quantum-chat.pcap ./quantum-chat.pcap
chmod 600 quantum-chat.pcap
scp YOUR_SERVER:~/quantum-chat/quantum-chat.pcap ~/Downloads/
```

Delete both server-side copies after the demonstration:

```bash
docker compose -f compose.prod.yml exec backend rm -f /tmp/quantum-chat.pcap
rm -f quantum-chat.pcap
```
