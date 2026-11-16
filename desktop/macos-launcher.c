#include <stdlib.h>
#include <string.h>

extern int ElectronMain(int argc, char* argv[]);
extern int ElectronInitializeICUandStartNode(int argc, char* argv[]);

int main(int argc, char* argv[]) {
  const char* run_as_node = getenv("ELECTRON_RUN_AS_NODE");
  if (run_as_node != NULL && run_as_node[0] != '\0' && strcmp(run_as_node, "0") != 0) {
    return ElectronInitializeICUandStartNode(argc, argv);
  }
  return ElectronMain(argc, argv);
}
