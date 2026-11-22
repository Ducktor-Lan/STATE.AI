# Deploy STATE.AI

[English](#english) · [简体中文](#中文) · [English README](../README.md) · [中文 README](../README.zh-CN.md)

## English

### Prepare the host and release

Use a dedicated Linux VPS with Docker Engine and the Docker Compose plugin. Point a public DNS hostname to the VPS and open TCP ports 80 and 443. One HTTP Basic Auth administrator account protects the entire site. Anyone who signs in can manage all matches, models and media. [Compose configuration](../compose.yaml) · [Caddy configuration](../Caddyfile)

From the root of the local checkout, archive the committed release and transfer the tar file to the VPS.

```sh
release=$(git rev-parse --verify HEAD)
git archive --format=tar --output="state-ai-${release}.tar" "$release"
```

On the VPS, run these commands from the directory that received the tar file. Replace `RELEASE_COMMIT` with the commit in the tar filename. Enter the administrator password at the interactive Caddy prompt.

```sh
release=RELEASE_COMMIT
mkdir -p "$HOME/state-ai/release-$release"
tar -xf "state-ai-${release}.tar" -C "$HOME/state-ai/release-$release"
cd "$HOME/state-ai/release-$release"
docker run --rm -it caddy:2.11.9-alpine caddy hash-password --algorithm bcrypt
umask 077
```

Create `../deploy.env` on the host. Use a lowercase hostname and an administrator username made of ASCII letters and digits. Keep the full bcrypt hash in single quotes to preserve its `$` characters.

```dotenv
STATE_AI_DOMAIN=arena.example.com
STATE_AI_AUTH_USER=owner
STATE_AI_AUTH_HASH='<paste the full bcrypt hash from Caddy>'
```

### Start and verify

```sh
chmod 600 ../deploy.env
docker compose -p state-ai --env-file ../deploy.env -f compose.yaml config --quiet
docker compose -p state-ai --env-file ../deploy.env -f compose.yaml up -d --build --force-recreate
```

Caddy provisions TLS certificates for the configured hostname. Open the site over HTTPS and sign in. A fresh deployment should show the two built-in models and an empty match history. The health check below prompts for the administrator password in the terminal.

```sh
curl --fail --user owner https://arena.example.com/api/health
```

Caddy and the app share a network namespace. The app listens on `127.0.0.1:4180` inside it. Caddy rejects mismatched TLS SNI and HTTP hosts and rejects a supplied Origin that differs from the public site. The app stores model registrations, matches and media in the `app-data` volume at `/data`. Caddy uses `caddy-data` at `/data` and `caddy-config` at `/config`. Web model registrations contain plaintext API keys, so limit access to the app volume and its backups.

To update, unpack the new committed archive into a fresh release directory and reuse `-p state-ai` and the same `../deploy.env` to retain the named volumes. Formal evaluation batches read the archive commit from `deploy/REVISION`.

### Recording and narration on Linux

Linux supports full-match video without narration and editing with imported WAV or MP3 audio. Windows System.Speech is available on Windows only. For cloud narration, use a Compose override on the deployment host to pass the backend TTS settings and secret to `app`. Set `TTS_PROVIDER=openai-compatible`, `TTS_ENDPOINT`, `TTS_MODEL` and `TTS_VOICE`. Set `TTS_API_KEY_ENV` to the name of the environment variable containing the key.

Local verification used `caddy validate` and `docker compose config --quiet`, and exercised authentication and request handling against a local Node service.

## 中文

### 准备主机和发布归档

准备独立 Linux VPS、Docker Engine 和 Docker Compose 插件。把公网域名指向 VPS，开放 TCP 80 和 443 端口。全站共用一组 HTTP Basic Auth 管理员凭据，登录后可管理全部对局、模型和媒体。 [Compose 配置](../compose.yaml) · [Caddy 配置](../Caddyfile)

在本地仓库根目录归档已提交的发布版本，再把 tar 文件传到 VPS。

```sh
release=$(git rev-parse --verify HEAD)
git archive --format=tar --output="state-ai-${release}.tar" "$release"
```

在 VPS 上从收到 tar 文件的目录执行以下命令。把 `RELEASE_COMMIT` 换成文件名中的提交标识，在 Caddy 的交互提示中输入管理员密码。

```sh
release=RELEASE_COMMIT
mkdir -p "$HOME/state-ai/release-$release"
tar -xf "state-ai-${release}.tar" -C "$HOME/state-ai/release-$release"
cd "$HOME/state-ai/release-$release"
docker run --rm -it caddy:2.11.9-alpine caddy hash-password --algorithm bcrypt
umask 077
```

在宿主机创建 `../deploy.env`。域名填小写主机名，用户名使用英文字母和数字，完整 bcrypt 哈希用单引号包住，以保留 `$` 字符。

```dotenv
STATE_AI_DOMAIN=arena.example.com
STATE_AI_AUTH_USER=owner
STATE_AI_AUTH_HASH='<粘贴 Caddy 输出的完整 bcrypt 哈希>'
```

### 启动和检查

```sh
chmod 600 ../deploy.env
docker compose -p state-ai --env-file ../deploy.env -f compose.yaml config --quiet
docker compose -p state-ai --env-file ../deploy.env -f compose.yaml up -d --build --force-recreate
```

Caddy 为配置的域名自动申请 TLS 证书。通过 HTTPS 访问并登录，首次启动应显示两个内置模型和空对局历史。下方命令会提示在终端输入管理员密码。

```sh
curl --fail --user owner https://arena.example.com/api/health
```

Caddy 和应用共享网络命名空间，应用只在其中监听 `127.0.0.1:4180`。Caddy 拒绝 TLS SNI 与 HTTP 主机不符的请求，也拒绝含异源 Origin 的请求。模型、对局和媒体保存在应用 `/data` 上的 `app-data` 命名卷。Caddy 的 `/data` 和 `/config` 分别使用 `caddy-data` 和 `caddy-config` 卷。网页登记的模型配置含明文 API Key，应限制对应用数据卷及其备份的访问。

更新时将新提交的归档解压到新的发布目录，沿用 `-p state-ai` 与同一份 `../deploy.env` 以复用命名卷。正式评测批次从归档里的 `deploy/REVISION` 读取发布提交标识。

### Linux 录像和旁白

Linux 支持整局无旁白录像，也支持导入 WAV 或 MP3 后剪辑。Windows System.Speech 仅在 Windows 上可用。需要云旁白时，通过部署主机上的 Compose 覆盖配置向 `app` 注入后端 TTS 设置和密钥。将 `TTS_PROVIDER` 设为 `openai-compatible`，配置 `TTS_ENDPOINT`、`TTS_MODEL`、`TTS_VOICE`，并将 `TTS_API_KEY_ENV` 设为存放密钥的环境变量名。

本地验证使用了 `caddy validate` 和 `docker compose config --quiet`，并连接本地 Node 服务检查了鉴权和请求处理。
