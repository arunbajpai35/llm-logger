# Runbook — demo lifecycle

Operational commands for the local kind + ngrok demo. All commands assume the working directory is the repo root and Docker Desktop is running.

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

# 3. If localhost:3000 doesn't respond once pods are Ready,
#    kube-proxy sometimes needs a nudge after the node restart:
kubectl -n kube-system delete pod -l k8s-app=kube-proxy

# 4. Public URL
ngrok http --url=marry-ooze-ferris.ngrok-free.dev 3000
```

## Sanity checks

```powershell
kubectl -n llm-logger get pods                          # everything Running?
curl http://localhost:3000/api/providers                # local app reachable?
curl -H "ngrok-skip-browser-warning: 1" `
     https://marry-ooze-ferris.ngrok-free.dev/api/providers  # tunnel reachable?
```

## Full teardown

```powershell
kind delete cluster --name llm-logger
# Removes the kind container and all data. Rebuild from /k8s/ manifests
# (see README "Deploy on Kubernetes (kind)" section) when you want it back.
```

## Re-deploying after a code change

```powershell
# 1. Rebuild the images locally
docker compose build app worker

# 2. Push them into the kind cluster
kind load docker-image llm-logger-app:latest llm-logger-worker:latest --name llm-logger

# 3. If the Prisma schema changed, re-run the migration Job
kubectl -n llm-logger delete job prisma-migrate --ignore-not-found
kubectl apply -f k8s/migrate-job.yaml

# 4. Restart the Deployments so they pick up the new image
kubectl -n llm-logger rollout restart deploy/web deploy/worker
```
