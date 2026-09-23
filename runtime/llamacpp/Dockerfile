FROM nvidia/cuda:12.8.1-devel-ubuntu24.04 AS llama-build
ARG LLAMA_CPP_REPOSITORY=https://github.com/lenkard/llama.cpp.git
ARG LLAMA_CPP_COMMIT=3c651da18
# Pin the CUDA architecture to the deployment GPU so nvcc does not fall back
# to a generic default (Docker builds cannot probe the host GPU). 86 = sm_86
# (RTX 3090). Override with --build-arg CUDA_ARCH= for other GPUs.
ARG CUDA_ARCH=86
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates cmake curl git build-essential && rm -rf /var/lib/apt/lists/*
RUN git clone "$LLAMA_CPP_REPOSITORY" /src/llama.cpp && cd /src/llama.cpp && \
    git checkout "$LLAMA_CPP_COMMIT" && \
    cmake -B build -DGGML_CUDA=ON -DGGML_CUDA_ARCH=$CUDA_ARCH -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release && \
    cmake --build build --target llama-diffusion-gemma-server -j"$(nproc)"

FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 python3-pip curl && rm -rf /var/lib/apt/lists/*
COPY --from=llama-build /src/llama.cpp/build/bin/ /opt/llama/bin/
COPY pyproject.toml LICENSE NOTICE ./
COPY djev/ ./djev/
RUN python3 -m pip install --no-cache-dir '.[tokenizer]'
COPY runtime/llamacpp/entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh
ENV HF_HOME=/cache/huggingface TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1
ENTRYPOINT ["/entrypoint.sh"]
