/* Deterministic offline adversary. All paths supplied by the synthetic runner.
 * No provider, user-profile discovery, or Keychain APIs. */
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#include <servers/bootstrap.h>
#include <mach/mach.h>

static void result(const char *op, int allowed, int error) {
    printf("{\"operation\":\"%s\",\"allowed\":%s,\"error\":%d}\n", op, allowed ? "true" : "false", error);
    fflush(stdout);
}
int main(int argc, char **argv) {
    if (argc < 3) return 64;
    const char *op = argv[1], *p = argv[2];
    if (!strcmp(op, "read") || !strcmp(op, "write")) {
        int writing = !strcmp(op, "write");
        int fd = open(p, writing ? O_WRONLY | O_CREAT | O_TRUNC : O_RDONLY, 0600);
        int err = errno, ok = fd >= 0;
        if (ok) { char b[128]; ok = (writing ? write(fd, "SYNTHETIC_WRITE", 15) : read(fd, b, sizeof(b))) >= 0; err = errno; close(fd); }
        result(op, ok, ok ? 0 : err);
    } else if (!strcmp(op, "stat")) {
        struct stat s; int ok = stat(p, &s) == 0; result(op, ok, ok ? 0 : errno);
    } else if (!strcmp(op, "list")) {
        DIR *d = opendir(p); int err = errno; result(op, d != NULL, d ? 0 : err); if (d) closedir(d);
    } else if (!strcmp(op, "fd")) {
        char b[128]; int ok = read(atoi(p), b, sizeof(b)) > 0; result(op, ok, ok ? 0 : errno);
    } else if (!strcmp(op, "exec")) {
        execl(p, p, (char *)0); result(op, 0, errno);
    } else if (!strcmp(op, "child") || !strcmp(op, "detached-read")) {
        pid_t child = fork(); if (child < 0) return 65;
        if (!child) {
            if (!strcmp(op, "detached-read") && setsid() < 0) _exit(69);
            execl(argv[0], argv[0], "read", p, (char *)0); _exit(66);
        }
        int status; waitpid(child, &status, 0); return WIFEXITED(status) ? WEXITSTATUS(status) : 67;
    } else if (!strcmp(op, "network")) {
        struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(atoi(p))};
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        int ok = fd >= 0 && connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0;
        int err = errno; if (fd >= 0) close(fd); result(op, ok, ok ? 0 : err);
    } else if (!strcmp(op, "unix")) {
        struct sockaddr_un addr = {.sun_family = AF_UNIX};
        snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", p);
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        int ok = fd >= 0 && connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0;
        int err = errno; if (fd >= 0) close(fd); result(op, ok, ok ? 0 : err);
    } else if (!strcmp(op, "mach")) {
        /* Lookup only; never send any Keychain request or access credentials. */
        mach_port_t port = MACH_PORT_NULL;
        kern_return_t rc = bootstrap_look_up(bootstrap_port, p, &port);
        result(op, rc == KERN_SUCCESS, rc);
        if (rc == KERN_SUCCESS) mach_port_deallocate(mach_task_self(), port);
    } else if (!strcmp(op, "linger") || !strcmp(op, "escape")) {
        pid_t child = fork(); if (child < 0) return 68;
        if (!child) {
            if (!strcmp(op, "escape") && setsid() < 0) _exit(69);
            /* Fixed short ceiling; the parent also cleans up this exact PID. */
            for (int n = 0; n < 80; n++) {
                int fd = open(p, O_WRONLY | O_CREAT | O_APPEND, 0600);
                if (fd >= 0) { write(fd, ".", 1); close(fd); }
                usleep(100000);
            }
            _exit(0);
        }
        printf("{\"childPid\":%d}\n", child); fflush(stdout);
        int status; waitpid(child, &status, 0);
    } else return 64;
    return 0;
}
