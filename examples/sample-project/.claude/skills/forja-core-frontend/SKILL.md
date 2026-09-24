---
name: forja-core-frontend
description: Implement or repair browser interactions and UI within the accepted design, including asynchronous state and accessibility.
disable-model-invocation: true
---

Implement the accepted visual and interaction contract. Read the existing components, styles and state owner before changing them. Preserve recognizable layout and content for a bounded fix. Seek design exploration only when the task needs a new direction; a frontend task is not automatically a redesign.

For asynchronous UI, identify which user intent owns a response. Trace both success and failure when requests overlap, the user clears or leaves, or a retry occurs. Cancellation alone does not prove an obsolete completion cannot update state. Update loading, empty, success and error states as one coherent transition; do not present stale items as results for a new query. Bind retry to the input required by the interaction contract, which may differ from unsubmitted edits. Preserve user focus unless the interaction explicitly requires moving it.

Use native semantic controls, associated labels and safe text insertion for untrusted content. Live announcements should describe useful changes without stealing focus or announcing obsolete results. Check the actual interactive state, not only an initial screenshot. Verify the supplied widths and long/empty/error content; do not mask overflow by clipping needed information.

Separate evidence by what was executed. If tools cannot run a browser, hand back the specific checks for the controller and inspect its screenshots/results when supplied. Do not claim keyboard, screen-reader, reduced-motion or responsive correctness from source inspection alone. Keep edits within the task and reuse established primitives.

Capture text at readable resolution: include desktop and narrow mobile viewports of the changed sections and relevant states, not only a tall full-page overview. Label paths with width and section/state, and recapture affected views after repairs. Request these outputs from the controller's browser helper when execution is restricted; never claim that an unavailable capture was produced.
