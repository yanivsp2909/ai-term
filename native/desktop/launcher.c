// No shell, PATH lookup or system Node: symlinks resolve to this installed bundle.
#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
 char image[PATH_MAX], own[PATH_MAX], electron[PATH_MAX], entry[PATH_MAX];
 uint32_t size=sizeof(image);
 if(_NSGetExecutablePath(image,&size)!=0||realpath(image,own)==NULL)goto fail;
 char *slash=strrchr(own,'/');if(!slash)goto fail;*slash='\0';
 if(snprintf(electron,sizeof(electron),"%s/AI Term",own)>=(int)sizeof(electron))goto fail;
 if(snprintf(entry,sizeof(entry),"%s/../Resources/app/dist/cli/index.js",own)>=(int)sizeof(entry))goto fail;
 char **args=calloc((size_t)argc+2,sizeof(char*));if(!args)goto fail;
 args[0]=electron;int at=1;
#ifdef AI_COMMAND
 args[at++]=entry;
#endif
 for(int i=1;i<argc;i++)args[at++]=argv[i];
 unsetenv("NODE_OPTIONS");unsetenv("NODE_PATH");unsetenv("ELECTRON_NO_ASAR");unsetenv("NAPI_RS_NATIVE_LIBRARY_PATH");
 if(setenv("ELECTRON_RUN_AS_NODE","1",1)!=0)goto fail;
 execv(electron,args);
fail:
 fputs("AI Term runtime could not start\n",stderr);return 1;
}
