use serde_json::Value;

/// Injected JavaScript that sets up the `window.encdr` bridge object.
///
/// App HTML calls `window.encdr.onMessage(channel, data)` — this is defined
/// by the app's JS code. We inject the plumbing that routes Rust→JS messages
/// to that handler, and JS→Rust signals back through `window.ipc.postMessage()`.
pub const BRIDGE_INIT_JS: &str = r#"
(function() {
    if (!window.encdr) {
        window.encdr = {};
    }
    if (!window.encdr.onMessage) {
        window.encdr.onMessage = function(channel, data) {};
    }
    window.encdr._dirty = false;
    window.encdr._rafId = null;

    window.encdr.requestCapture = function() {
        if (window.ipc) {
            window.ipc.postMessage('__encdr_frame_ready');
        }
    };
})();
"#;

/// Build a JS snippet that calls `window.encdr.onMessage(channel, data)`
/// and then requests a capture.
pub fn build_send_js(channel: &str, data: &Value) -> String {
    let data_json = serde_json::to_string(data).unwrap_or_else(|_| "null".to_string());
    format!(
        r#"(function() {{
            var capture = true;
            var payload = {data};
            if (window.encdr && window.encdr.onMessage) {{
                try {{
                    capture = window.encdr.onMessage({ch}, payload) !== false;
                }} catch (error) {{
                    if (window.ipc) window.ipc.postMessage('__encdr_error:' + String(error) + ' | ' + String(error.stack || ''));
                    return;
                }}
            }}
            if (!capture) return {{stateSeq: (payload && payload.traceStateSeq) || 0, latestInputSeq: (payload && payload.traceInputSeq) || 0, changed: false}};
            if (window.encdr && typeof window.encdr.requestCapture === 'function') {{
                window.encdr.requestCapture();
            }} else if (window.ipc) {{
                window.ipc.postMessage('__encdr_frame_ready');
            }}
            return {{stateSeq: (payload && payload.traceStateSeq) || 0, latestInputSeq: (payload && payload.traceInputSeq) || 0, changed: true}};
        }})();"#,
        ch = serde_json::to_string(channel).unwrap_or_else(|_| "\"\"".to_string()),
        data = data_json,
    )
}

/// Advance app animation while explicitly forwarding evaluator exceptions.
pub const ADVANCE_JS: &str = "(function(){try{window.encdr?.advanceAnimation?.()}catch(error){window.ipc?.postMessage('__encdr_error:'+String(error)+' | '+String(error.stack||''));}})()";
