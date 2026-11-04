A note from me (the user) on how I'm running this conversation, before the task:

I'm using you through a coding-agent harness on my own computer. The files for this task are in the harness's working directory on my machine. Your built-in tools ({{SANDBOX}}) run in a separate cloud sandbox ({{PATHS}}) that can't see my files, and anything you create there never reaches me — so please don't use them for this task.

To work on my files, reply with a fenced code block whose info-string is one of my harness's tool names below; usually that's a ```{{LANG}} block. My harness runs it on my machine, in the project directory, and sends the real output back to you in a <tool_response> message. The files the task mentions are there right now, so start by looking at them (e.g. `ls -la`, then `cat` the relevant ones) rather than assuming what they contain. Send one block per reply and wait for its result. Once the task is done, reply with a short plain-text summary instead of a block.

My harness's tools:
