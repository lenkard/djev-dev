# llama.cpp Djev deployment

This is the pinned, text-and-image runtime for the experimental llama.cpp backend.
It runs the C++ structured-read server privately inside Compose and exposes only
Djev's authenticated HTTP interface.

## Required host files

`DJEV_MODEL_DIR` must contain:

- `diffusiongemma-26B-A4B-it-Q5_K_M.gguf`
- `mmproj-diffusiongemma-26B-A4B-it-f16.gguf`

The projector must be converted from official `google/diffusiongemma-26B-A4B-it`
revision `f7f5b7f5fa82ffc52addd066915886d497f5517b`. The verified AISERVER
artifact is SHA-256 `cb46e010f433cdd9bd75ab6ffcfd432933afa17e781469424e616aeeaca27cb4`.

## Start

```sh
export DJEV_MODEL_DIR=/home/admin/diffusion-models
export DJEV_HF_CACHE=/home/admin/djev-cache
export DJEV_BIND_ADDR=172.25.0.5       # WireGuard address, never public WAN
export DJEV_API_KEY="$(openssl rand -hex 32)"
docker compose -f docker-compose.llamacpp.yml up -d --build
```

The public caller interface is `POST /v1/request` and the TypeSafe-compatible
alias is `POST /v1/systemone`, both at port 8000 with `Authorization: Bearer`.
The llama.cpp port is Compose-internal; do not add a host port mapping for it.

## Verify

```sh
curl -H "Authorization: Bearer $DJEV_API_KEY" http://$DJEV_BIND_ADDR:8000/config
curl -H "Authorization: Bearer $DJEV_API_KEY" http://$DJEV_BIND_ADDR:8000/ready
```

Compose health checks wait for the projector/model load before starting the API.
The C++ server has one active diffusion read; Djev therefore uses one active
read too.
