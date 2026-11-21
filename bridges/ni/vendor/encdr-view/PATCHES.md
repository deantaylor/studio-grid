# Local modifications — 2026-11-11

Source: RufusIbiza/Encdr, published encdr-view 0.8.5, crate source commit `4e1fa75aa329fc18823be88e6a0c1b385f53f6ac`, path `encdr-view`. Upstream: https://github.com/RufusIbiza/Encdr. License: GPL-3.0-or-later as declared in Cargo.toml. LICENSE is the upstream repository license file at that commit, including its original metadata.

- src/webview_macos.rs: create each window on the first event callback instead of requiring StartCause::Init on the reused Tao event loop. Unpatched second view failed with “Window was not created”; patched dual-window mock ran successfully.
- src/capture_macos.rs: replace deprecated msg_send_id with msg_send, retaining the typed Option<Retained<NSBitmapImageRep>> result. Checked by compilation; physical screen capture still needs validation.

Source and manifest are preserved except these explicit changes. Registry packaging markers and the dependency's own Cargo.lock are omitted; the project Cargo.lock controls resolution. These modifications remain under GPL-3.0-or-later. Local app/source packaging is provided by scripts/package_local.py. Preserve license/source notices when distributing this dependency and audit the complete application license before distribution.

Additional changes on 2026-11-11:

- src/webview_macos.rs: queue a user event before creation/pumping run_return calls, reducing the risk of waiting in an idle NSApplication loop before quit/signal handling can resume. Record WindowEvent::CloseRequested in thread-local state and return it from pump_events.
- src/lib.rs: propagate the macOS close request through ScreenView::pump_events. Application loops can now request clean shutdown when either preview is closed.
- Three bounded mock sessions verified normal quit and SIGINT exits after this change; physical shutdown and closing a window still need user checks. This is a hang mitigation, not a proven root-cause fix.


Screen responsiveness fix (11 November 2026):

- src/capture_macos.rs: factor snapshot request/completion into PendingSnapshot and AsyncCapture. Normal poll is nonblocking, with one in-flight request per view, an after-screen-updates capture, dirty-state preservation during capture, timeout/error recovery and optional completion statistics. The explicit synchronous capture API remains available for compatibility.
- src/lib.rs: ScreenView/DualScreenView macOS poll starts/completes snapshots asynchronously. Left/right requests can overlap. Ownership/backlog gating remains on submission; retarget discards the old pending request. Capture readiness is consumed at request time so a newer update is not cleared by an older completion.
- Application src/main.rs now sends latest state independently of the USB backlog and keeps captures bounded in the view. MK3_SCREEN_TIMING=1 reports completion timing for diagnosis. Input polling no longer waits for two sequential snapshot callbacks.
- Physical NI-service route check: g1-state/screen-timing-1794405471207652000/ (ignored). 19 captures per screen completed; observed maximum completion times about36.4ms left/51.8ms right, final23.2/32.5ms, command-loop median14.4ms (worst203.8ms). Service transfer acknowledgements were present. These measure callback/conversion and controller-loop timing, not panel scanout or a claimed before/after speed ratio. No NI agents stopped; emulator/current patch left running.


Inter/list animation support (11 November 2026):

- src/bridge.rs: an onMessage return value of false now explicitly skips a redundant capture; existing undefined/other return values retain the original behavior. The live renderer compares only the values visible on each screen.
- src/webview_macos.rs + src/lib.rs: `__encdr_animate:<milliseconds>` requests a native-clock capture burst, clamped to one second. This avoids hidden-WebKit timer throttling during CSS transitions, with no persistent idle capture loop. Ownership/backlog gates remain in effect.
- Actual MK3 animation check: g1-state/screen-timing-1794407875832862000/ (ignored), 67 left/10 right completed captures, final23.2/29.5ms; command-loop median14.2ms/max117ms. Cold maximum137ms. Real-WebKit check observed the intermediate CSS transform then its settled position. No key mappings or NI service configuration changed.

Capture conversion follow-up (11 November 2026): reuse existing nonplanar 8-bit RGBA NSBitmapImageRep snapshots instead of TIFF encoding/decoding each frame. Other layouts retain the TIFF fallback. Encdr and encdr-view use optimization level 2 in developer builds to reduce per-pixel conversion costs. Physical speed improvement is not measured when MK3 is unavailable.

Stable animation snapshots (11 November 2026): AsyncCapture coalesces dirty updates with a minimum33ms start interval and advances an optional JS advanceAnimation hook immediately before each native snapshot. G1 rows use ordinary top positions/opacity rather than promoted transform layers or delayed cleanup timers. Visible previews also advance with a bounded timer. This keeps motion alive in hidden views without an idle frame loop. Physical screen-only timing check g1-state/screen-timing-1794421931407362000 passed: latest capture times about19.9/18.8ms, controller command-loop median13.9ms; cold maxima143/146ms. These are capture/loop measurements, not a perceived-smoothness guarantee.

Deeper latency diagnostics (11 November 2026): report WebView JavaScript errors via IPC, and shorten bounded CoreFoundation pumping from5ms to1ms. The application trace mode MK3_TRACE_FRAMES creates hidden preview views and runs AsyncCapture with per-frame pixel-band/timing output, enabling tests during reversals rather than only after DOM settling. No persistent capture loop is enabled in normal idle use.

Fault recovery: capture timeout is 1500ms; optional required-header ink guard rejects blank output without replacing the last good frame. Retained HTML/current state reload and replay after snapshot or explicitly reported JavaScript errors, with 5s cooldown. State dispatch and animation hooks report exceptions through IPC. Hidden real-WebKit tests verified blank-output rejection and injected exception recovery with selection retained.

Captured main-loop freeze fix (12 November 2026): a live sample of the stalled controller showed its main thread in Tao run_return / NSApplication::run while LED/screen workers waited for new output and independent pad input remained active. Tao 0.37.2 keeps ControlFlow::Exit sticky; repeatedly entering/exiting the same AppKit loop was not a safe per-frame pump. ManagedWebView now creates windows directly, and run_event_loop owns AppKit once for the session with scheduled ticks and per-tick autorelease pools. Legacy pump_events only services bounded CF callbacks and never enters NSApplication::run. ScreenView supports an unbound size for pre-loop view creation, then binding on device discovery; retarget preserves the ink guard. Application preview snapshots now complete asynchronously instead of waiting inside a UI callback. Hidden quit/SIGINT, reversal/fault-recovery, real MIDI and capture checks passed; the live controller was restarted against the same emulator and heartbeats/captures continued beyond the observed freeze interval. Earlier re-entry wake mitigation above is superseded.

13 November 2026: STUDIO_GRID_NI_BACKGROUND selects Tao Accessory activation policy, hides the Dock icon and avoids activating over the DAW. Hardware rendering and the persistent AppKit loop remain in use; manual previews retain their existing policy.

13 November 2026 S49 latency follow-up: AsyncCapture has an optional per-view interval (default33ms). The S49 application sets16ms. Preserve the interval through replay/recovery/retarget; retain one in-flight snapshot, dirty/latest-state coalescing and backpressure checks. No unbounded capture or idle rendering loop added.

13 November 2026 hidden-renderer follow-up: configure Wry BackgroundThrottlingPolicy::Disabled for macOS views. Pinned Wry0.57.2 documents default hidden-view throttling/suspension and macOS14+ support via WKPreferences.inactiveSchedulingPolicy. State JS evaluation now reports completion latency >100ms via callback, covering render scheduling delay absent from capture-only stats. No frame-rate or capture-queue changes. Short hidden actual-WebKit DOM update check16–21ms; long-idle/physical timing unverified.

13 November2026 requested opt-in pipeline trace: WebView dispatch logs state/input IDs; build_send_js returns stateSeq/latestInputSeq/changed to JS completion callback without duplicating payload serialization. Completed capture logs RGBA content hash for correlation with transfer-worker input. MK3_TRACE_PIPELINE/absolute MK3_TRACE_UNTIL_MS gate trace; no scheduling changes. Capture hash cannot prove exact physical scanout or exclusive state-to-pixel identity.
