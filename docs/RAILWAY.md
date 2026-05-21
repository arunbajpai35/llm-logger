# Deploying on Railway

Railway hosts the whole stack (web + worker + Postgres + Redis) from this one repo. Plan: two services pointed at this GitHub repo with different start commands, plus two managed plugins for Postgres and Redis.

## 1. Create the project

1. Go to https://railway.com → **Login with GitHub**.
2. Add a payment card (required even for the trial). Trial credit covers a small project.
3. **New Project** → **Deploy from GitHub repo** → pick `arunbajpai35/llm-logger`.

Railway will detect the `Dockerfile` and start building. Let the first deploy run; we'll edit it next.

## 2. Add the datastores

In the project canvas:

- Click **+ New** → **Database** → **Add PostgreSQL**.
- Click **+ New** → **Database** → **Add Redis**.

Each one comes with a `DATABASE_URL` / `REDIS_URL` variable on the database service.

## 3. Configure the `web` service

Click the auto-created service (named after the repo). Open the **Settings** tab.

- Rename it to `web`.
- **Networking** → **Generate Domain** (gives you `web-production-xxxx.up.railway.app`).
- **Build** → leave Dockerfile detection on.
- **Deploy** → **Custom Start Command**:
  ```
  npx prisma migrate deploy && npm start
  ```

Open the **Variables** tab on the `web` service and add (use Railway's reference syntax `${{Postgres.DATABASE_URL}}` for shared values):

| Key | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `NODE_ENV` | `production` |
| `OPENAI_API_KEY` | _your key, or leave blank if using Azure_ |
| `AZURE_OPENAI_API_KEY` | _your key_ |
| `AZURE_OPENAI_ENDPOINT` | `https://anuragmisra-aifoundry1.cognitiveservices.azure.com` |
| `AZURE_OPENAI_DEPLOYMENT` | `gpt-4.1-mini` |
| `AZURE_OPENAI_API_VERSION` | `2025-01-01-preview` |
| `GROQ_API_KEY` | _your Groq key_ |

Save → Railway will redeploy.

## 4. Add the `worker` service

Back on the canvas, **+ New** → **GitHub Repo** → pick `arunbajpai35/llm-logger` again.

- Rename it to `worker`.
- **Settings → Deploy → Custom Start Command**:
  ```
  npm run worker
  ```
- **Networking** → leave it private (no domain — worker doesn't serve HTTP).
- **Variables**: add the same `DATABASE_URL`, `REDIS_URL`, `NODE_ENV` references as web (worker only needs DB + Redis, no LLM keys).

## 5. Verify

Once both services are green:

- Open the `web` domain → chat UI should load.
- Send a message → should stream back.
- `/dashboard` → metrics tile should populate after ~10s as the worker drains the queue.
- `/conversations` → the message you just sent should appear.

If the web service crash-loops with `Table "public.Conversation" does not exist`, the migrate step didn't run. Check the deploy logs for the `prisma migrate deploy` output. The schema migrates on every web boot.

## Costs

Trial credit is enough to keep this running idle for a couple of weeks. After that, the lightest-running Hobby plan is $5/mo. Pause or delete the project to stop the meter.
