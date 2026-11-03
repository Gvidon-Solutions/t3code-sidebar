# Context in portable handoffs

T3 Code transfers provider context when you switch providers, continue through a portable
restart, or use a fork that the provider cannot resume itself.

Short conversations transfer intact. For longer conversations, T3 Code favors recent requests and
answers, the original request, and relevant activity such as command outcomes. Selected messages
keep their full text, order, and user or assistant role, including partial work from failed or
interrupted turns. Your new request stays separate and is never shortened to make history fit.

Codex receives historical messages directly when its installed version supports that operation.
Other providers receive the same selection as attributed conversation context. A provider handoff does not
copy the outgoing provider's reasoning, tool-call state, or attachments.

The handoff includes references to omitted history. The agent can use T3 Code's thread-reading tool
to retrieve saved messages and activity, including the remainder of a long item. For an important
constraint, you can still repeat it in your next message. A handoff is a budgeted selection, not an
agent-written summary.

## Move to another machine

Choose **Move to project…** from a thread's menu, then select a project on the other machine.
On web, you can also drag the thread onto that project's folder. Finish or stop the running turn
first. Confirming the move copies the visible conversation and attachments, keeps the thread's
model and modes, and archives the original with a link to its continuation. The destination stays
idle until you send a message. For ten seconds, **Undo** restores the original and archives the
continuation, provided no turn is running there.

Each copied transcript item is limited to 32,000 characters; shortened items say how much was
omitted and retain a link to the original conversation. Your next turn receives the copied history
within the context limits below. Copied attachments remain available on the destination machine.

## Context limits

A handoff must leave room for existing provider context, your request and attachments, instructions,
tools, and subsequent work. If the target conversation has no room for the handoff, T3 Code starts
a fresh provider conversation with a bounded selection of saved history and sends your request
automatically. You do not need to compact manually. If the request and attachments leave too little
room even in a fresh conversation, shorten the request or select a larger-context model. T3 Code
never shortens your request to make it fit.

Recovery leaves running background work intact. Let it finish or stop it before retrying the handoff.

Server operators can set `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` to change the initial history allowance
(default 16,000; clamped to 1,024–64,000). This is an upper bound, not a provider context-window
guarantee. Text accounting conservatively charges one token per UTF-8 byte, including attribution
and JSON escaping. Imported history has a separate 64,000-byte ceiling; your current input and
attachment payloads do not consume that ceiling.

T3 Code uses available capacity information for your selected model and options, together with
provider context telemetry. Starting a fresh provider conversation clears prior usage, while keeping
known model capacity. Changing models or context-window options discards stale usage and compaction
thresholds.

When no capacity information is available, T3 Code assumes a 128,000-token window. It reserves at
least 16,000 tokens, or a quarter of the window when larger, for instructions, tools, and subsequent
work. Images reserve an estimated 8,192 tokens each, independent of their file size; other
attachments reserve 4,096 each for their references. Existing context is estimated from saved
activity when usage telemetry is unavailable. Known smaller windows still constrain the handoff.
These are fallback estimates, not exact token counts. Image resolution, custom models, and hidden
native context can differ, so the provider may still reject an input.

When moving a conversation, choose its destination model in the confirmation. The picker lists that machine’s providers and model options. Your current selection stays selected when available; otherwise the destination default is selected with a notice. You can also change the model during a move on the same machine. A different harness receives the conversation as context.

Agents can pass `modelSelection` to `t3_thread_move`. The CLI accepts `t3ctl move <thread> --project <project> --on <machine> --agent <instance> --model <model> --effort <level>`; these choices resolve on the destination.
