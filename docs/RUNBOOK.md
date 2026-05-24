# Runbook — demo lifecycle

Operational commands for the local kind + ngrok demo. All commands assume the working directory is the repo root and Docker Desktop is running.

## Topology refresher

- **`kind` cluster** (`llm-logger-control-plane`) hosts the whole stack.
- Namespace `llm-logger` has: `postgres`, `redis`, `web` (Deployment), `worker` (Deployment), `prisma-migrate` (Job).
- The **web image** is the Next.js standalone bundle — runs `node server.js`, no Prisma CLI, small.
- The **worker image** keeps full `node_modules` + Prisma CLI — used by both the `worker` Deployment and the `prisma-migrate` Job.
- **`src/instrumentation.ts`** installs the SDK monkey-patch at server boot. Look for `[instrument] installed: openai` in the web pod logs on startup as the proof it ran.
- Public URL is whatever's pinned in `docs/RUNBOOK.md` — currently `marry-ooze-ferris.ngrok-free.dev`.

## Pause

Stops the app but keeps the cluster, Postgres, and Redis alive. Lowest-friction "step away" state.

```powershell
kubectl -n llm-logger scale deploy/web deploy/worker --replicas=0
# Close the terminal running `ngrok` (or kill the process) to drop the public URL.
```

## Resume (after a pause)

```powershell
kubectl -n llm-logger scale deploy/web --replicas=1
kubectl -n llm-logger scale deploy/worker --replicas=1
kubectl -n llm-logger get pods -w
# Ctrl+C once web + worker show 1/1 Running.

ngrok http --url=marry-ooze-ferris.ngrok-free.dev 3000
# Leave this terminal open while the link should be live.
```

## Cold restart (after laptop reboot or Docker quit)

```powershell
# 1. Bring the kind node back up
docker start llm-logger-control-plane

# 2. Wait ~20s for kubelet, then scale the app
kubectl -n llm-logger scale deploy/web --replicas=1
kubectl -n llm-logger scale deploy/worker --replicas=1
kubectl -n llm-logger get pods -w

# 3. After a node restart, two things often need a kick:
#    - kube-proxy gets stale conntrack entries, breaking NodePort routing
kubectl -n kube-system delete pod -l k8s-app=kube-proxy
#    - CoreDNS gets stale resolvers, breaking outbound DNS (Azure/Groq fail with ENOTFOUND)
kubectl -n kube-system delete pod -l k8s-app=kube-dns

# 4. Public URL
ngrok http --url=marry-ooze-ferris.ngrok-free.dev 3000
```

## Sanity checks

```powershell
kubectl -n llm-logger get pods                          # everything Running?
kubectl -n llm-logger logs -l app=web --tail=3 | findstr instrument  # patch installed?
curl http://localhost:3000/api/providers                # local app reachable?
curl -H "ngrok-skip-browser-warning: 1" `
     https://marry-ooze-ferris.ngrok-free.dev/api/providers  # tunnel reachable?
```

Expected:
- `kubectl get pods` shows postgres, redis, web, worker all `1/1 Running`; `prisma-migrate` shows `Completed`.
- Web logs contain `[instrument] installed: openai`.
- `/api/providers` returns `{"providers":["openai","groq"]}`.

## Full teardown

```powershell
kind delete cluster --name llm-logger
# Removes the kind container and all data. Rebuild from /k8s/ manifests
# (see README "Deploy on Kubernetes (kind)" section) when you want it back.
```

## Re-deploying after a code change

```powershell
# 1. Rebuild both images locally. Compose builds two stages (web-runner +
#    worker-runner) — web is the standalone Next.js bundle, worker keeps the
#    full node_modules for the Prisma CLI.
docker compose build app worker

# 2. Push both images into the kind cluster.
kind load docker-image llm-logger-app:latest llm-logger-worker:latest --name llm-logger

# 3. If the Prisma schema changed (new migration under prisma/migrations/),
#    re-run the migration Job. The Job uses the WORKER image because the web
#    standalone bundle has no Prisma CLI.
kubectl -n llm-logger delete job prisma-migrate --ignore-not-found
kubectl apply -f k8s/migrate-job.yaml

# 4. If any k8s YAML changed (web.yaml command, env, ports, secret keys, …),
#    apply the manifest so the Deployment spec updates. `rollout restart`
#    alone won't pick up YAML edits.
kubectl apply -f k8s/web.yaml -f k8s/worker.yaml

# 5. Restart the Deployments so they pull the new image.
kubectl -n llm-logger rollout restart deploy/web deploy/worker
kubectl -n llm-logger rollout status deploy/web --timeout=120s
```

## Updating secrets

```powershell
# Replace the whole Secret (kubectl can't merge env keys atomically).
kubectl -n llm-logger delete secret app-secrets --ignore-not-found
kubectl -n llm-logger create secret generic app-secrets `
  --from-literal=OPENAI_API_KEY=sk-... `
  --from-literal=GROQ_API_KEY=gsk_... `
  --from-literal=AZURE_OPENAI_API_KEY=... `
  --from-literal=AZURE_OPENAI_ENDPOINT=... `
  --from-literal=AZURE_OPENAI_DEPLOYMENT=... `
  --from-literal=AZURE_OPENAI_API_VERSION=2025-01-01-preview

# Pods read env at start — restart to pick up the change.
kubectl -n llm-logger rollout restart deploy/web deploy/worker
```

## Compose path (alternative to kind)

Same code, different orchestrator. Useful for quick local iteration without the k8s layer.

```powershell
# Bring up the stack. Migrations run via the dedicated `migrate` one-shot
# service; app + worker depend on `migrate: condition: service_completed_successfully`
# so they only start once the schema is up.
docker compose up --build

# Tear down (keeps the pgdata volume).
docker compose down

# Tear down AND wipe data.
docker compose down -v
```

## Common failure modes

- **`localhost:3000` hangs after a node restart** → kube-proxy stale conntrack. `kubectl -n kube-system delete pod -l k8s-app=kube-proxy`.
- **Web logs show `ENOTFOUND` for the Azure/Groq host** → CoreDNS stale. `kubectl -n kube-system delete pod -l k8s-app=kube-dns`.
- **InferenceLog rows arrive with `conversationId = NULL`** → the AsyncLocalStorage `Symbol.for()` pinning in `src/lib/instrument/core.ts` got removed; webpack bundle splits will then give each chunk its own ALS instance. Restore the `globalThis[STORE_KEY]` singleton.
- **`status = success` on a clearly cancelled call** → the patch's signal-based cancel detection got removed; OpenAI wraps `AbortError` into `APIUserAbortError`, which a `name === "AbortError"` check misses. Make sure `callerSignal?.aborted` is checked as ground truth.
- **CI fails on `next lint`** → check `.eslintrc.json` exists and `eslint-config-next` is in devDeps. `next lint` will go interactive in CI otherwise.
- **Compose web container crashes on boot with `sh: next: not found`** → web image is the standalone stage; its CMD is `node server.js`, not `npm start`. If a YAML override is passing `npm start`, remove it.
