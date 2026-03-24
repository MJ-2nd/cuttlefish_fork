// fd passing 검증: 송신 측 (CVD-1 역할)
// memfd로 테스트 프레임버퍼를 만들고 Unix socket으로 fd 전달
//
// 빌드: g++ -o sender sender.cpp
// 실행: ./sender /tmp/fd_test.sock

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

struct FrameMeta {
  int32_t width;
  int32_t height;
  int32_t format;
  int32_t stride;
};

int create_test_buffer(int width, int height) {
  size_t size = width * height * 4;
  int fd = memfd_create("test_framebuffer", MFD_ALLOW_SEALING);
  if (fd < 0) {
    perror("memfd_create");
    return -1;
  }
  if (ftruncate(fd, size) < 0) {
    perror("ftruncate");
    close(fd);
    return -1;
  }

  uint8_t* pixels = (uint8_t*)mmap(nullptr, size, PROT_WRITE, MAP_SHARED, fd, 0);
  if (pixels == MAP_FAILED) {
    perror("mmap");
    close(fd);
    return -1;
  }

  // 테스트 패턴: R과 B 그라데이션
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      int idx = (y * width + x) * 4;
      pixels[idx + 0] = (uint8_t)(x * 255 / width);   // R
      pixels[idx + 1] = 0;                              // G
      pixels[idx + 2] = (uint8_t)(y * 255 / height);   // B
      pixels[idx + 3] = 255;                             // A
    }
  }
  munmap(pixels, size);

  printf("[sender] Created buffer: fd=%d, %dx%d RGBA (%zu bytes)\n",
         fd, width, height, size);
  return fd;
}

int send_fd(int socket_fd, int fd_to_send, const FrameMeta* meta) {
  struct iovec iov = {
      .iov_base = (void*)meta,
      .iov_len = sizeof(*meta),
  };

  char cmsg_buf[CMSG_SPACE(sizeof(int))];
  memset(cmsg_buf, 0, sizeof(cmsg_buf));

  struct msghdr msg = {};
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = cmsg_buf;
  msg.msg_controllen = sizeof(cmsg_buf);

  struct cmsghdr* cmsg = CMSG_FIRSTHDR(&msg);
  cmsg->cmsg_level = SOL_SOCKET;
  cmsg->cmsg_type = SCM_RIGHTS;
  cmsg->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(cmsg), &fd_to_send, sizeof(int));

  ssize_t sent = sendmsg(socket_fd, &msg, 0);
  if (sent < 0) {
    perror("sendmsg");
    return -1;
  }
  printf("[sender] Sent fd=%d via SCM_RIGHTS (%zd bytes metadata)\n",
         fd_to_send, sent);
  return 0;
}

int main(int argc, char* argv[]) {
  if (argc != 2) {
    fprintf(stderr, "Usage: %s <socket_path>\n", argv[0]);
    return 1;
  }
  const char* socket_path = argv[1];
  const int WIDTH = 720;
  const int HEIGHT = 1280;

  // 1. 테스트 프레임버퍼 생성
  int buffer_fd = create_test_buffer(WIDTH, HEIGHT);
  if (buffer_fd < 0) return 1;

  // 2. receiver에 연결
  int sock = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un addr = {};
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, socket_path, sizeof(addr.sun_path) - 1);

  printf("[sender] Connecting to %s ...\n", socket_path);
  while (connect(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
    if (errno == ENOENT || errno == ECONNREFUSED) {
      sleep(1);
      continue;
    }
    perror("connect");
    return 1;
  }
  printf("[sender] Connected!\n");

  // 3. fd 전송
  FrameMeta meta = {
      .width = WIDTH,
      .height = HEIGHT,
      .format = 0x34324241,  // DRM_FORMAT_ABGR8888
      .stride = WIDTH * 4,
  };
  if (send_fd(sock, buffer_fd, &meta) < 0) return 1;

  // 4. 확인 응답 대기
  char ack[64] = {};
  read(sock, ack, sizeof(ack) - 1);
  printf("[sender] Response: %s\n", ack);

  close(sock);
  close(buffer_fd);
  return 0;
}
