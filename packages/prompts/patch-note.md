# Patch tool

The patch failed. Send a corrected `patch` block using the required patch format:

```patch
*** Begin Patch
*** Update File: path/to/file
@@
 existing context
-old content
+new content
*** End Patch
```

Use paths and context confirmed from the real files. Start with `*** Begin Patch`, finish with `*** End Patch`, and do not use `---` or `+++` Git diff headers. If the file contents may have changed, inspect the file again with one `bash` block before retrying.
