# Deploying

Placeholders: `<TUNNEL-UUID>` is the ID `cloudflared tunnel create` prints.
The private runbook for the actual box has the real values; nothing here is
secret.

## 1. Status service (on the server)

```
sudo git clone --single-branch --branch main https://github.com/Plorbus/plorbserver-status.git /opt/plorbserver-status
sudo cp /opt/plorbserver-status/server/plorbserver-status.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now plorbserver-status
curl -s http://127.0.0.1:8090/        # JSON, with real "active" states
systemd-analyze security plorbserver-status
```

The code is owned by root and the service runs as a `DynamicUser`, so the
running service cannot modify its own code. Update with
`sudo git -C /opt/plorbserver-status pull && sudo systemctl restart plorbserver-status`.

## 2. Cloudflare Tunnel

Install `cloudflared` from Cloudflare's apt repository (Ubuntu doesn't
package it):

```
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared
```

Create the tunnel (any machine with a browser; pick the `plorbus.dev` zone
when logging in, because `route dns` writes into that zone):

```
cloudflared tunnel login
cloudflared tunnel create plorbserver
cloudflared tunnel route dns plorbserver api.plorbus.dev
cloudflared tunnel route dns plorbserver t.plorbus.dev
```

On the server, a dedicated user owns the credentials, readable by it alone:

```
sudo adduser --system --group --no-create-home cloudflared
sudo install -d -o root -g cloudflared -m 0750 /etc/cloudflared
sudo install -o cloudflared -g cloudflared -m 0400 <TUNNEL-UUID>.json /etc/cloudflared/
# config: server/cloudflared/config.example.yml with the UUID filled in
sudo install -o root -g cloudflared -m 0640 config.yml /etc/cloudflared/config.yml
cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
sudo cp /opt/plorbserver-status/server/cloudflared/cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cloudflared
```

Then delete `cert.pem` (from `tunnel login`) and the local copy of the
credentials file. `cert.pem` can create and delete tunnels and DNS records
for the whole account, and running a tunnel doesn't need it.

## 3. Worker + page

```
npx wrangler login
npx wrangler d1 create plorbserver-status          # put the ID in wrangler.jsonc
npx wrangler d1 migrations apply plorbserver-status --remote
npx wrangler deploy                                # also creates status.plorbus.dev + its certificate
npx wrangler logout
```
