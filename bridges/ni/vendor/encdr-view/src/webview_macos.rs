// Modified 2026-11-11: see ../PATCHES.md (GPL-3.0-or-later).
use std::cell::{Cell, RefCell};
use std::sync::{Arc, Mutex};
use tao::event::{Event, WindowEvent};

use objc2_core_foundation::{kCFRunLoopDefaultMode, CFRunLoop};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::platform::run_return::EventLoopExtRunReturn;
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
use tao::window::WindowBuilder;

use crate::bridge;

// Thread-local event loop shared across all ManagedWebView instances.
// WKWebView requires main-thread access, so all views share one event loop.
thread_local! {
    static CLOSE_REQUESTED: Cell<bool> = const { Cell::new(false) };
    static EVENT_LOOP: RefCell<Option<EventLoop<()>>> = RefCell::new(None);
}

fn with_event_loop<F, R>(f: F) -> R
where
    F: FnOnce(&mut EventLoop<()>) -> R,
{
    EVENT_LOOP.with(|cell| {
        let mut opt = cell.borrow_mut();
        if opt.is_none() {
            let mut event_loop = EventLoop::new();
            if std::env::var_os("STUDIO_GRID_NI_BACKGROUND").is_some() {
                event_loop.set_activation_policy(ActivationPolicy::Accessory);
                event_loop.set_dock_visibility(false);
                event_loop.set_activate_ignoring_other_apps(false);
            }
            *opt = Some(event_loop);
        }
        f(opt.as_mut().unwrap())
    })
}

pub fn pipeline_trace_enabled() -> bool {
    if std::env::var_os("MK3_TRACE_PIPELINE").is_none(){return false;}
    let until=std::env::var("MK3_TRACE_UNTIL_MS").ok().and_then(|s|s.parse::<u128>().ok()).unwrap_or(u128::MAX);
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()<until
}

pub struct ManagedWebView {
    pub webview: wry::WebView,
    _window: tao::window::Window,
    pub width: u32,
    pub height: u32,
    html: String,
    last_state: std::cell::RefCell<Option<String>>,
    page_loaded: Arc<std::sync::atomic::AtomicBool>,
    page_ready: Arc<std::sync::atomic::AtomicBool>,
    script_failed: Arc<std::sync::atomic::AtomicBool>,
    last_recovery: std::cell::Cell<Option<std::time::Instant>>,
    pub frame_ready: Arc<Mutex<bool>>,
    pub animation_until: Arc<Mutex<std::time::Instant>>,
}

impl ManagedWebView {
    pub fn new(width: u32, height: u32, html: &str, visible: bool) -> Result<Self, String> {
        let frame_ready = Arc::new(Mutex::new(false));
        let frame_ready_ipc = frame_ready.clone();
        let animation_until = Arc::new(Mutex::new(std::time::Instant::now()));
        let animation_ipc = animation_until.clone();
        let html_owned = html.to_string();
        let page_loaded=Arc::new(std::sync::atomic::AtomicBool::new(false));
        let loaded_callback=page_loaded.clone();
        let page_ready=Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ready_callback=page_ready.clone();
        let script_failed=Arc::new(std::sync::atomic::AtomicBool::new(false));
        let script_callback=script_failed.clone();

        // Tao supports creating windows before run(). Do not enter/exit NSApplication
        // to construct each view: Exit is sticky on macOS, making later run_return
        // calls unreliable and leaving the caller trapped in AppKit's event wait.
        let window = with_event_loop(|event_loop| {
            WindowBuilder::new()
                .with_visible(visible)
                .with_inner_size(tao::dpi::LogicalSize::new(width as f64,height as f64))
                .with_decorations(visible).with_resizable(false)
                .with_title(if visible {"encdr-view"} else {""})
                .build(&*event_loop).map_err(|e|format!("Failed to create window: {e}"))
        })?;
        let fr = frame_ready_ipc.clone();
        let animation = animation_ipc.clone();
        let script_error=script_callback.clone();
        let webview = wry::WebViewBuilder::new()
            // These hidden views are live hardware renderers, not background
            // browser tabs. Otherwise WebKit can throttle/suspend their JS work.
            .with_background_throttling(wry::BackgroundThrottlingPolicy::Disabled)
            .with_html(&html_owned)
            .with_initialization_script(bridge::BRIDGE_INIT_JS)
            .with_on_page_load_handler({let loaded=loaded_callback.clone();move |event,_|{
                if matches!(event,wry::PageLoadEvent::Finished){loaded.store(true,std::sync::atomic::Ordering::Relaxed);ready_callback.store(true,std::sync::atomic::Ordering::Relaxed);}
            }})
            .with_ipc_handler(move |request| {
                if let Some(ms) = request
                    .body()
                    .strip_prefix("__encdr_animate:")
                    .and_then(|value| value.parse::<u64>().ok())
                {
                    if let Ok(mut until) = animation.lock() {
                        if ms==0{*until=std::time::Instant::now();}else{*until = (*until).max(
                            std::time::Instant::now()
                                + std::time::Duration::from_millis(
                                    ms.min(1000),
                                ),
                        );}
                    }
                }
                if let Some(error) = request.body().strip_prefix("__encdr_error:") {
                    tracing::error!("WebView JavaScript error: {}; requesting view recovery", error);
                    script_error.store(true,std::sync::atomic::Ordering::Relaxed);
                }
                if request.body() == "__encdr_frame_ready" {
                    if let Ok(mut ready) = fr.lock() {
                        *ready = true;
                    }
                }
            })
            .with_bounds(wry::Rect {
                position: wry::dpi::Position::Logical(
                    wry::dpi::LogicalPosition::new(0.0, 0.0),
                ),
                size: wry::dpi::Size::Logical(wry::dpi::LogicalSize::new(
                    width as f64,
                    height as f64,
                )),
            })
            .build(&window).map_err(|e|format!("Failed to create WebView: {e}"))?;

        Ok(Self {
            webview,
            html: html.to_string(),last_state: std::cell::RefCell::new(None),page_loaded,page_ready,
            last_recovery: std::cell::Cell::new(None),script_failed,
            _window: window,
            width,
            height,
            frame_ready,
            animation_until,
        })
    }

    pub fn is_page_ready(&self)->bool{self.page_ready.load(std::sync::atomic::Ordering::Relaxed)}
    pub fn is_frame_ready(&self) -> bool {
        self.frame_ready.lock().map(|r| *r).unwrap_or(false)
    }

    pub fn clear_frame_ready(&self) {
        if let Ok(mut r) = self.frame_ready.lock() {
            *r = false;
        }
    }

    pub fn replay_loaded(&self) -> bool {
        if self.script_failed.swap(false,std::sync::atomic::Ordering::Relaxed){
            if let Err(error)=self.recover(){tracing::warn!("Script recovery failed: {error}");}
            return false;
        }
        if !self.page_loaded.swap(false,std::sync::atomic::Ordering::Relaxed){return false;}
        if let Some(js)=self.last_state.borrow().as_ref(){
            if let Err(error)=self.webview.evaluate_script(js){tracing::warn!("State replay failed: {error}");}
        }
        if let Ok(mut ready)=self.frame_ready.lock(){*ready=true;}
        true
    }
    pub fn recover(&self) -> Result<(), String> {
        if self.last_recovery.get().is_some_and(|last|last.elapsed()<std::time::Duration::from_secs(5)){return Ok(());}
        self.last_recovery.set(Some(std::time::Instant::now()));
        self.page_ready.store(false,std::sync::atomic::Ordering::Relaxed);
        self.webview.load_html(&self.html).map_err(|error|error.to_string())
    }
    pub fn eval(&self, js: &str) -> Result<(), String> {
        if js.contains("capture = window.encdr.onMessage("){self.last_state.replace(Some(js.to_string()));}
        let started=std::time::Instant::now();
        let is_state=js.contains("capture = window.encdr.onMessage(");
        let trace=is_state && pipeline_trace_enabled();
        let view_id=self as *const Self as usize;
        self.webview
            .evaluate_script_with_callback(js,move |result| {
                if trace {tracing::info!("PIPELINE stage=js_complete view={} elapsed_ms={:.3} result={}",view_id,started.elapsed().as_secs_f64()*1000.,result);}
                if is_state && started.elapsed()>std::time::Duration::from_millis(100) {
                    tracing::warn!("Screen state JavaScript took {:.1}ms before completion",started.elapsed().as_secs_f64()*1000.);
                }
            })
            .map_err(|e| format!("JS eval failed: {}", e))
    }

    pub fn load_html(&self, html: &str) -> Result<(), String> {
        self.webview
            .load_html(html)
            .map_err(|e| format!("Failed to load HTML: {}", e))
    }
}

/// Own AppKit once for the session. Each application tick is scheduled by Tao's
/// run-loop timer; no frame re-enters NSApplication::run or consumes a sticky Exit.
pub fn run_event_loop(mut tick: impl FnMut()->bool) {
    CLOSE_REQUESTED.with(|closed|closed.set(false));
    with_event_loop(|event_loop| {
        event_loop.run_return(|event,_,control_flow| {
            match event {
                Event::WindowEvent{event:WindowEvent::CloseRequested,..} => {
                    CLOSE_REQUESTED.with(|closed|closed.set(true));
                    *control_flow=ControlFlow::Exit;
                }
                Event::MainEventsCleared => {
                    if objc2::rc::autoreleasepool(|_|tick()){*control_flow=ControlFlow::WaitUntil(std::time::Instant::now()+std::time::Duration::from_millis(2));}
                    else{*control_flow=ControlFlow::Exit;}
                }
                _=>{}
            }
        });
    });
}

/// Bounded WebKit callback pumping for synchronous screenshot helpers. Window
/// events belong to run_event_loop; never start another NSApplication::run here.
pub fn pump_events() -> bool {
    unsafe {CFRunLoop::run_in_mode(kCFRunLoopDefaultMode,0.001,true);}
    CLOSE_REQUESTED.with(Cell::get)
}
