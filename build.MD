docker build --file "tools/buildutils/cw/Containerfile" --tag "android-cuttlefish-build:latest" .

docker run -v=$HOME/.cache/bazel:/root/.cache/bazel -v=$PWD:/mnt/build -w /mnt/build android-cuttlefish-build:latest base

docker run -v=$HOME/.cache/bazel:/root/.cache/bazel -v=$PWD:/mnt/build -w /mnt/build android-cuttlefish-build:latest frontend

./container/image-builder.sh -m dev -t cuttlefish-orchestration:composite