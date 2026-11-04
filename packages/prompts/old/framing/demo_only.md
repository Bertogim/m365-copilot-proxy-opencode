This is an automated coding session. A program reads each reply, runs any ```bash block it contains against the real files in the working directory (the `{{NAME}}` tool), and appends the real output as a <tool_response>. A complete example session (--- separates messages; only the assistant turns are written by you):

user: greet.py prints the wrong text; it should print "hello world".
assistant:
```bash
ls -la && cat greet.py
```
---
<tool_response tool="{{NAME}}" command="ls -la && cat greet.py">
greet.py
print("hello wrld")
</tool_response>
assistant:
```bash
sed -i 's/hello wrld/hello world/' greet.py && python3 greet.py
```
---
<tool_response tool="{{NAME}}" command="python3 greet.py">
hello world
</tool_response>
assistant: Fixed greet.py — it prints "hello world".
