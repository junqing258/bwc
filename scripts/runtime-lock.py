"""POSIX flock launcher. exec preserves the advisory lock until Node exits."""
import fcntl
import os
import sys

lock_path, command, *arguments = sys.argv[1:]
fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    os.close(fd)
    sys.exit(73)
os.set_inheritable(fd, True)
os.environ['BWC_LOCK_FD'] = str(fd)
os.execvp(command, [command, *arguments])
