# compile-server/Dockerfile
#
# Stateless Retro68 compile server. Receives C source files via HTTP POST,
# runs m68k-apple-macos-gcc through CMake, and returns a complete MacBinary.
#
# Base image: the official Retro68 container used by CI (Debian-based, toolchain
# at /Retro68-build/toolchain/). Pinning to the same image guarantees output
# parity with CI-produced binaries.
#
# Build:
#   docker build -t cvm-compile-server compile-server/
#
# Run locally (for testing):
#   docker run --rm -p 8080:8080 \
#     -e ALLOWED_ORIGINS=http://localhost:5173 \
#     --network=none \
#     cvm-compile-server
#
# NOTE: --network=none prevents the compiler from making outbound connections
# during compilation. Pass --network=bridge or omit only if you need the
# container itself to pull packages (e.g., during development).

FROM ghcr.io/autc04/retro68:latest

# Install Python 3 + pip into the Retro68 container. The image is
# Debian-based and runs as root (consistent with the CI workflow).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /compile-server

COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt \
    || pip3 install --no-cache-dir -r requirements.txt

COPY server.py .

EXPOSE 8080

# Non-root user for the server process. Compilation still runs as this user;
# the Retro68 toolchain is world-readable in /Retro68-build/.
RUN useradd -m -u 1001 appuser \
    && chown -R appuser:appuser /compile-server
USER appuser

CMD ["python3", "server.py"]
