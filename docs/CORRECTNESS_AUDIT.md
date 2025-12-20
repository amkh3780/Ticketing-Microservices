# Correctness & Configuration Audit

## Configuration defects (file + reason)
- `infra/k8s/auth-depl.yaml`, `orders-depl.yaml`, `tickets-depl.yaml`, `payments-depl.yaml`: reference `jwt-secret` (and `payments` also `stripe-secret`), but the base secret set is missing both, so pods crash at start (`JWT_KEY`/`STRIPE_KEY` envs unset). Base `infra/k8s/secrets.yaml` only defines mongo/redis/nats/ingress-tls secrets.
- `infra/k8s/nats-depl.yaml`: `readOnlyRootFilesystem: true` with no writable volume; NATS Streaming needs a writable store dir and will fail to start when run as non-root (uid 1001) on a read-only FS.
- `infra/k8s/secrets.yaml` + `infra/k8s/ingress-srv.yaml`: ingress forces TLS (`ssl-redirect: "true"`, `tls:` block) but ships a hard-coded dummy cert/key; results in invalid TLS handshakes/broken security until replaced.
- `infra/k8s/nats-depl.yaml` vs `infra/k8s/netpol.yaml`: service exposes monitoring port 8222, but NetworkPolicy only allows 4222; monitoring endpoint is unreachable.
- `infra/k8s-ci/patch-imagepullsecret.yaml`: injects `imagePullSecrets: ghcr-creds` for every deployment, but no such secret is created anywhere; applying the CI kustomization fails.

## Kubernetes manifest inconsistencies
- `infra/k8s/nats-depl.yaml`: declares monitoring port 8222 via Service while NetworkPolicy blocks it (no matching ingress rule).
- `infra/k8s/ingress-srv.yaml` + `infra/k8s/secrets.yaml`: TLS enforced but certificate is a placeholder dummy, yielding unusable TLS.

## Environment divergence (base vs CI overlays)
- Secrets: CI overlay (`infra/k8s-ci/ci-secrets.yaml`) creates `jwt-secret` and `stripe-secret`; base manifests omit them. Skaffold/local deployments (base) will fail while CI passes, leaving configurations unaligned.
- NATS: base requires auth and read-only FS; CI overlay (`patch-nats-no-auth.yaml`) removes auth flag, disables read-only, and adds `emptyDir`, so CI exercises a different NATS setup than production.
- Storage/TLS: CI overlays delete all PVCs and replace them with `emptyDir` plus disable TLS on ingress (`patch-ingress-no-tls.yaml`), so persistence and transport security differ between CI and base deployments.

## Missing or invalid secrets / volumes / policies
- Missing secrets: `jwt-secret`, `stripe-secret` absent from base (`infra/k8s/secrets.yaml`) though referenced by deployments; pods cannot load required env vars.
- Missing volume for NATS: `infra/k8s/nats-depl.yaml` provides no writable volume with a read-only root, preventing stateful startup.
- Missing image pull secret: CI overlay expects `ghcr-creds` but does not create it.
