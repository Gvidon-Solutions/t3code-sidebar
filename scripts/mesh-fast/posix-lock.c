#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  int fd = open(argv[1], O_RDWR);
  if (fd < 0) {
    perror("open private lock");
    return 1;
  }
  {
    const char suffix[] = ".shutdown-wait.json";
    char *report = malloc(strlen(argv[1]) + sizeof(suffix));
    if (!report) { perror("allocate lock receipt"); close(fd); return 1; }
    strcpy(report, argv[1]);
    strcat(report, suffix);
    FILE *output = fopen(report, "w");
    free(report);
    if (!output) { perror("open lock receipt"); close(fd); return 1; }
    if (fprintf(output, "{\"pid\":%ld,\"lockType\":\"POSIX\"}\n", (long)getpid()) < 0 || fclose(output) != 0) {
      perror("write lock receipt");
      close(fd);
      return 1;
    }
  }
  struct flock lock = {.l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0};
  alarm(30);
  if (fcntl(fd, F_SETLKW, &lock) < 0) {
    perror("wait for private lock");
    close(fd);
    return 1;
  }
  alarm(0);
  close(fd);
  return 0;
}
