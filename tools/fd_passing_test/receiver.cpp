// fd passing 검증: 수신 측 (CVD-0 역할)
// Unix socket에서 fd를 받아 mmap으로 내용 확인
//
// 빌드: g++ -o receiver receiver.cpp
// 실행: ./receiver /tmp/fd_test.sock

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

int recv_fd(int conn_fd, FrameMeta* meta) {
  struct iovec iov = {
      .iov_base = meta,
      .iov_len = sizeof(*meta),
  };

  char cmsg_buf[CMSG_SPACE(sizeof(int))];
  memset(cmsg_buf, 0, sizeof(cmsg_buf));

  struct msghdr msg = {};
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = cmsg_buf;
  msg.msg_controllen = sizeof(cmsg_buf);

  ssize_t n = recvmsg(conn_fd, &msg, 0);
  if (n <= 0) {
    perror("recvmsg");
    return -1;
  }

  struct cmsghdr* cmsg = CMSG_FIRSTHDR(&msg);
  if (!cmsg || cmsg->cmsg_level != SOL_SOCKET ||
      cmsg->cmsg_type != SCM_RIGHTS) {
    fprintf(stderr, "[receiver] No SCM_RIGHTS in message\n");
    return -1;
  }

  int received_fd = -1;
  memcpy(&received_fd, CMSG_DATA(cmsg), sizeof(int));
  return received_fd;
}

int main(int argc, char* argv[]) {
  if (argc != 2) {
    fprintf(stderr, "Usage: %s <socket_path>\n", argv[0]);
    return 1;
  }
  const char* socket_path = argv[1];

  // 1. Unix socket 서버 생성
  unlink(socket_path);
  int srv = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un addr = {};
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, socket_path, sizeof(addr.sun_path) - 1);

  if (bind(srv, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
    perror("bind");
    return 1;
  }
  listen(srv, 1);
  printf("[receiver] Listening on %s ...\n", socket_path);

  // 2. sender 연결 대기
  int conn = accept(srv, nullptr, nullptr);
  if (conn < 0) {
    perror("accept");
    return 1;
  }
  printf("[receiver] Sender connected!\n");

  // 3. fd 수신
  FrameMeta meta = {};
  int buffer_fd = recv_fd(conn, &meta);
  if (buffer_fd < 0) {
    fprintf(stderr, "[receiver] Failed to receive fd\n");
    return 1;
  }
  printf("[receiver] Received fd=%d, frame=%dx%d, stride=%d\n",
         buffer_fd, meta.width, meta.height, meta.stride);

  // 4. 수신한 fd를 mmap하여 내용 검증
  size_t size = meta.height * meta.stride;
  uint8_t* pixels =
      (uint8_t*)mmap(nullptr, size, PROT_READ, MAP_SHARED, buffer_fd, 0);
  if (pixels == MAP_FAILED) {
    perror("mmap received fd");
    close(buffer_fd);
    return 1;
  }

  // 첫 픽셀과 중앙 픽셀 읽기
  printf("[receiver] Pixel[0,0]     RGBA = (%d, %d, %d, %d)\n",
         pixels[0], pixels[1], pixels[2], pixels[3]);
  int mid = (meta.height / 2 * meta.width + meta.width / 2) * 4;
  printf("[receiver] Pixel[mid,mid] RGBA = (%d, %d, %d, %d)\n",
         pixels[mid], pixels[mid + 1], pixels[mid + 2], pixels[mid + 3]);

  // 5. 검증: 좌상단은 어둡고, 중앙은 밝아야 함 (그라데이션 패턴)
  bool ok = (pixels[0] < 10) && (pixels[mid] > 100);
  printf("[receiver] Verification: %s\n", ok ? "PASS" : "FAIL");

  // 6. 응답 전송
  const char* ack = ok ? "VERIFIED_OK" : "VERIFIED_FAIL";
  write(conn, ack, strlen(ack));

  munmap(pixels, size);
  close(buffer_fd);
  close(conn);
  close(srv);
  unlink(socket_path);
  printf("[receiver] Done.\n");
  return 0;
}
