# Server par deploy karna

App ko 24x7 chalane ke liye ek server chahiye. Server IT dega: Linux ya Windows, dono chalenge.

## Server se pehle IT se kya chahiye
1. **Fixed public IP** wala server/VM (1 CPU, 1 GB RAM kaafi hai).
2. Us IP ko **Autoline API par whitelist** karwana (ya API key). Iske bina 403 aayega.
3. Server se bahar internet (HTTPS 443) khula ho: `ykacentralapi.almoayyed.com.bh` aur `*.myshopify.com`.
4. Server par login: Linux ke liye SSH, Windows ke liye Remote Desktop.
5. Server ka time zone kuch bhi ho sakta hai. App khud `TIMEZONE=Asia/Bahrain` use karta hai.

---

## Option R: Render (render.com)

1. Code ko ek **private** GitHub repo mein daalo. `.env` kabhi upload mat karna (`.gitignore` use rokta hai).
2. Render Dashboard → **New → Blueprint** → woh repo chuno. `render.yaml` se service khud ban jayegi:
   Starter plan, Singapore region, 1 GB disk `/var/data` par.
3. Render secrets maangega. Yeh bharo: `SHOPIFY_ADMIN_TOKEN`, `ADMIN_TOKEN` (lamba random),
   `AUTOLINE_EXTRA_HEADERS` (IT se mile to, warna khali), `ALERT_WEBHOOK_URL` (optional).
4. Deploy ho jaane ke baad dashboard kholo: `https://<service-name>.onrender.com/?token=ADMIN_TOKEN`
5. Service page par **Connect → Outbound** se IP list copy karo aur IT ko do, taaki woh Autoline par whitelist karein.
   Yeh IP Render ki doosri services ke saath shared hote hain. Apne alag IP ke liye Render Pro + Dedicated IPs lena padega.
6. Logs check karne ke baad Environment mein `DRY_RUN=false` karo. Service apne aap restart ho jayegi.
7. Parts list badalni ho to GitHub par `parts-list.csv` edit karke commit karo. Render apne aap redeploy kar dega.
8. Laptop wala app band kar do.

Render ke Free plan par mat chalana: woh 15 minute baad so jaata hai aur logs mit jaate hain.

## Option A: Linux (Ubuntu)

```bash
# 1) Node.js LTS install
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs unzip
node -v

# 2) App ke liye alag user aur folder
sudo useradd --system --create-home --shell /usr/sbin/nologin autoline
sudo mkdir -p /opt/autoline-sync
# zip ko server par copy karo (WinSCP / scp), phir:
sudo unzip autoline-sync.zip -d /opt/
sudo chown -R autoline:autoline /opt/autoline-sync

# 3) .env banao (apni local .env ka content copy karo)
sudo -u autoline nano /opt/autoline-sync/.env
sudo chmod 600 /opt/autoline-sync/.env

# 4) Test (sab sahi aana chahiye)
cd /opt/autoline-sync
sudo -u autoline npm run test-autoline -- NKUHD65SLEDT
sudo -u autoline npm run test-shopify -- UHD65SLEDT

# 5) Service ki tarah chalao (reboot ke baad bhi apne aap chalega)
sudo cp deploy/autoline-sync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now autoline-sync
sudo systemctl status autoline-sync        # "active (running)" dikhna chahiye
journalctl -u autoline-sync -f             # live logs (Ctrl+C se bahar)
```

**Restart / stop:** `sudo systemctl restart autoline-sync` / `sudo systemctl stop autoline-sync`

## Option B: Windows Server

1. Node.js LTS install karo (nodejs.org). Phir `node -v` se check karo.
2. Zip ko `C:\autoline-sync` mein extract karo aur `.env` copy karo.
3. PowerShell mein:
   ```
   cd C:\autoline-sync
   npm run test-autoline -- NKUHD65SLEDT
   npm run test-shopify -- UHD65SLEDT
   ```
4. Windows service banao **NSSM** se (nssm.cc se download karo, `nssm.exe` ko `C:\nssm\` mein rakho). PowerShell **Administrator** ke roop mein kholo:
   ```
   C:\nssm\nssm.exe install AutolineSync "C:\Program Files\nodejs\node.exe" "C:\autoline-sync\src\server.js"
   C:\nssm\nssm.exe set AutolineSync AppDirectory C:\autoline-sync
   C:\nssm\nssm.exe set AutolineSync AppStdout C:\autoline-sync\logs\service.log
   C:\nssm\nssm.exe set AutolineSync AppStderr C:\autoline-sync\logs\service.log
   C:\nssm\nssm.exe set AutolineSync Start SERVICE_AUTO_START
   C:\nssm\nssm.exe start AutolineSync
   ```
5. `services.msc` kholo. "AutolineSync" ka status **Running** hona chahiye.

**Restart / stop:** `nssm restart AutolineSync` / `nssm stop AutolineSync`

(Alternative: `npm install -g pm2`, phir `pm2 start deploy/ecosystem.config.js` aur `pm2 save`.)

---

## Dashboard kaise kholein (safe tarika)
Default `HOST=127.0.0.1` hai, yaani dashboard sirf server ke andar se khulta hai. Yahi sabse safe hai.

- **Windows server:** Remote Desktop se server mein jao aur browser mein kholo: `http://localhost:3000/?token=ADMIN_TOKEN`
- **Linux server:** apne laptop se SSH tunnel banao:
  ```
  ssh -L 3000:127.0.0.1:3000 user@SERVER_IP
  ```
  Phir apne laptop ke browser mein: `http://localhost:3000/?token=ADMIN_TOKEN`

Agar team ko office network se seedha kholna hai, to `HOST=0.0.0.0` karo, **lekin** firewall mein port 3000 sirf office IPs ke liye kholna. Internet par khula mat chhodna. Kabhi public URL chahiye to IT se nginx + HTTPS lagwana.

## Live karne se pehle checklist
- [ ] `test-autoline` teeno rooftops ke liye OK:
      `npm run test-autoline -- NKUHD65SLEDT --rooftop SOE4P_PH` (aur SOE3P_PH, SOC1P_PH)
- [ ] `test-shopify` mein sahi locations dikhen ("Stock will be synced to")
- [ ] Pehle `DRY_RUN=true` ke saath 1 din chalao aur logs check karo
- [ ] Phir `DRY_RUN=false` karo aur service restart karo
- [ ] `ADMIN_TOKEN` lamba aur random ho, `.env` kisi ko share na ho
- [ ] `ALERT_WEBHOOK_URL` set ho (Teams/Slack), taaki outage ke alerts aayein
- [ ] Laptop wala app band karo. Ek time par **sirf ek jagah** app chalna chahiye.

## Update karna (naya code aaye to)
1. Service stop karo.
2. `src/` aur `scripts/` ki files replace karo. **`.env`, `parts-list.csv`, `state.json`, `logs/` mat chhoona.**
3. Service start karo aur dashboard check karo.

## Backup
Yeh files important hain, inka backup rakho:
- `.env`
- `parts-list.csv`
- `state.json` (yeh yaad rakhta hai ki app ne kaunse products DRAFT kiye the)
- `logs/` (12 mahine ka record)
