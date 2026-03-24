# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Android Cuttlefish — host-side tooling for preparing a host and booting Cuttlefish, a configurable Android Virtual Device (AVD). Targets locally hosted Linux x86/arm64 and Google Compute Engine instances.

## Build System

The primary build tool is **Bazel** (version in `base/cvd/.bazelversion`). All Bazel commands must be run from `base/cvd/`.

### Common Commands

```bash
# Build everything (from base/cvd/)
cd base/cvd && bazel build '//cuttlefish/...:all'

# Run all C++ unit tests
cd base/cvd && bazel test '//cuttlefish/...:all'

# Run a specific test
cd base/cvd && bazel test //cuttlefish/path/to/target:test_name

# Build and run cvd
cd base/cvd && bazel run cuttlefish/package:cvd -- reset -y

# Generate compile_commands.json for LSP
cd base/cvd && bazel run @hedron_compile_commands//:refresh_all

# Fix missing stdlib modules
cd base/cvd && bazel clean --expunge

# Format BUILD.bazel files
cd base/cvd && buildozer '//cuttlefish/...:__pkg__' format

# Remove unused load statements
cd base/cvd && buildozer '//cuttlefish/...:__pkg__' 'fix unusedLoads'

# Build Debian packages
./tools/buildutils/build_packages.sh

# Go frontend tests (from each project dir in frontend/src/)
cd frontend/src/host_orchestrator && go test ./...
```

## Architecture

### `base/cvd/` — Core C++ Codebase (Bazel root)
- `cuttlefish/host/commands/` — ~45 executables: `run_cvd` (init-style process manager), `assemble_cvd` (device assembly), `cvd` (main CLI tool), `stop`, `start`, `status`, etc.
- `cuttlefish/host/libs/` — Library modules: `config` (device configuration), `web` (HTTP/REST), `vm_manager`, `image_aggregator`, `metrics`, `screen_connector`, `input_connector`, `audio_connector`, etc.
- `cuttlefish/common/` — Shared utilities
- `cuttlefish/result/` — Custom Result/Error types (`result.h`, `expect.h`)

### `frontend/` — Web UI and Orchestration (Go + Angular)
- `src/host_orchestrator/` — REST API service (Go), API docs via swag
- `src/operator/` — Go service with Angular web UI
- `src/liboperator/`, `src/libhoclient/` — Go libraries

### `e2etests/` — End-to-end tests (Go + Bazel)

### `container/` — Docker/Podman container definitions

### Debian Packages
Built via `tools/buildutils/`: `cuttlefish-base`, `cuttlefish-user`, `cuttlefish-integration`, `cuttlefish-orchestration`.

## Key Conventions

### C++ Rules
- **C++20** standard (`-std=c++20`)
- **Must use `cf_cc_binary`, `cf_cc_library`, `cf_cc_test`** instead of native `cc_binary`/`cc_library`/`cc_test` — defined in `cuttlefish/bazel/rules.bzl`. These wrappers auto-generate clang-tidy targets. CI enforces this.
- **Code style**: Google style (`.clang-format` with `BasedOnStyle: Google`)
- **UBSan** is always enabled (alignment, array-bounds, enum, null, return, etc.) — see `.bazelrc`
- **clang-tidy** checks are defined in `.clang-tidy`; tidy targets are excluded from default builds via `--build_tag_filters=-clang_tidy`

### Go
- `gofmt` enforced on all frontend Go code
- `staticcheck` lint enforced on Go modules
- REST API changes in `host_orchestrator` require running `swag init` / `swag fmt`

### BUILD files
- Format with `buildozer '//cuttlefish/...:__pkg__' format`
- No unused `load` statements (CI checks this)

## CI/CD

Presubmit runs on GitHub Actions (`.github/workflows/presubmit.yaml`):
- BUILD file formatting and target rule validation (no native cc_* under `//cuttlefish`)
- C++ unit tests
- Go tests, gofmt, staticcheck
- API documentation check (swag)
- Debian package builds (amd64 + arm64)
- Docker/Podman image builds
- E2E orchestration tests (sharded, in containers)

Kokoro CI (`.kokoro/`) for additional pre-submit and E2E testing with GCE.

## MUST RULE
- ALWAYS, ALWAYS ANSWER IN KOREAN
