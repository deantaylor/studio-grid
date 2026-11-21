// Modified 2026-11-11: propagate macOS close requests; see ../PATCHES.md.
//! # encdr-view
//!
//! WebView-based screen renderer for hardware controller screens.
//!
//! Renders HTML/CSS/Canvas content via an offscreen WebView, captures the
//! rendered pixels, and feeds them through encdr's GPU pipeline for format
//! conversion, frame diffing, and USB transfer.
//!
//! Supported platforms:
//! - **Linux**: GTK + WebKitGTK snapshot capture
//! - **macOS**: tao + wry + WKWebView `takeSnapshot` capture
//! - **Windows**: tao + wry + WebView2 `CapturePreview` capture

pub mod bridge;

#[cfg(target_os = "linux")]
pub mod capture;
#[cfg(target_os = "linux")]
pub mod webview;

#[cfg(target_os = "macos")]
pub mod capture_macos;
#[cfg(target_os = "macos")]
pub mod webview_macos;

#[cfg(target_os = "windows")]
pub mod capture_windows;
#[cfg(target_os = "windows")]
pub mod webview_windows;

use encdr::core::descriptor::PixelFormat;
use encdr::core::event::DeviceId;
use encdr::Encdr;
use serde_json::Value;

/// How to load content into a ScreenView.
pub enum ScreenContent {
    /// Inline HTML string.
    Html(String),
    /// Path to an HTML file on disk.
    File(String),
}

impl ScreenContent {
    fn to_html(&self) -> Result<String, String> {
        match self {
            ScreenContent::Html(html) => Ok(html.clone()),
            ScreenContent::File(path) => {
                std::fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {}", path, e))
            }
        }
    }
}

/// A WebView-backed screen renderer for a single device screen.
///
/// Manages an offscreen WebView sized to the device screen's native resolution.
/// The app pushes state updates via `send()`, the HTML/CSS/JS renders the UI,
/// and `ScreenView` automatically captures pixels and submits them through
/// encdr's GPU pipeline → frame diff → USB transfer.
pub struct ScreenView {
    #[cfg(target_os = "linux")]
    inner: webview::ManagedWebView,
    #[cfg(target_os = "macos")]
    inner: webview_macos::ManagedWebView,
    #[cfg(target_os = "windows")]
    inner: webview_windows::ManagedWebView,
    #[cfg(target_os = "macos")]
    capture: std::cell::RefCell<capture_macos::AsyncCapture>,
    device_id: DeviceId,
    screen_name: String,
}

impl ScreenView {
    /// Create a new WebView-backed screen for a connected device.
    ///
    /// The WebView is sized to match the device screen's native resolution.
    /// If `visible` is true, a desktop window is shown (useful for debugging).
    /// Otherwise it renders headless off-screen.
    pub fn new(
        encdr: &Encdr,
        device_id: DeviceId,
        screen_name: &str,
        content: ScreenContent,
        visible: bool,
    ) -> Result<Self, String> {
        let descriptor = encdr
            .device_descriptor(device_id)
            .ok_or_else(|| format!("Device {:?} not connected", device_id))?;

        let screen_desc = descriptor
            .screens
            .iter()
            .find(|s| s.name == screen_name)
            .ok_or_else(|| format!("Screen '{}' not found on device", screen_name))?;

        let width = screen_desc.width as u32;
        let height = screen_desc.height as u32;
        Self::with_size(device_id,screen_name,(width,height),content,visible)
    }

    /// Create before the event loop/device connection; bind via set_device_id later.
    pub fn new_unbound(screen_name:&str,size:(u32,u32),content:ScreenContent,visible:bool)->Result<Self,String>{
        Self::with_size(DeviceId::default(),screen_name,size,content,visible)
    }
    fn with_size(device_id:DeviceId,screen_name:&str,(width,height):(u32,u32),content:ScreenContent,visible:bool)->Result<Self,String>{
        if width==0 || height==0 || width>4096 || height>4096{return Err("Invalid screen size".into());}
        let html = content.to_html()?;

        #[cfg(target_os = "linux")]
        let inner = webview::ManagedWebView::new(width, height, &html, visible)?;

        #[cfg(target_os = "macos")]
        let inner = webview_macos::ManagedWebView::new(width, height, &html, visible)?;

        #[cfg(target_os = "windows")]
        let inner = webview_windows::ManagedWebView::new(width, height, &html, visible)?;

        Ok(Self {
            inner,
            #[cfg(target_os = "macos")]
            capture: std::cell::RefCell::new(capture_macos::AsyncCapture::default()),
            device_id,
            screen_name: screen_name.to_string(),
        })
    }

    /// Update the target DeviceId (e.g. after a controller reconnects at a new USB address).
    pub fn set_device_id(&mut self, device_id: DeviceId) {
        self.device_id = device_id;
        #[cfg(target_os = "macos")]
        {
            let mut capture=self.capture.borrow_mut();let guard=capture.require_ink;
            *capture=capture_macos::AsyncCapture::default();capture.require_ink=guard;
        }
    }

    /// Push a state update to the WebView.
    ///
    /// Calls `window.encdr.onMessage(channel, data)` in the WebView's JS context.
    pub fn send(&self, channel: &str, data: Value) {
        #[cfg(target_os="macos")]
        if webview_macos::pipeline_trace_enabled(){tracing::info!("PIPELINE stage=webview_send screen={} state_seq={} latest_input_seq={}",self.screen_name,data["traceStateSeq"],data["traceInputSeq"]);}
        let js = bridge::build_send_js(channel, &data);
        if let Err(e) = self.inner.eval(&js) {
            tracing::warn!("Failed to send to WebView: {}", e);
        }
    }

    /// Capture the current WebView contents and submit to encdr for USB transfer.
    ///
    /// Does nothing while another client (e.g. NI's software) has the
    /// hardware; a pending frame stays flagged, so the next call after
    /// control returns captures the page as it is then.
    pub fn capture_and_submit(&self, encdr: &Encdr) -> Result<(), String> {
        if !encdr.has_control(self.device_id) {
            tracing::trace!("Skipping WebView capture: another application has the hardware");
            return Ok(());
        }

        #[cfg(target_os = "linux")]
        let (_w, _h, rgba) = capture::capture_webview_pixels(
            &self.inner.webkit_view,
            self.inner.width,
            self.inner.height,
        )?;

        #[cfg(target_os = "macos")]
        let (_w, _h, rgba) = capture_macos::capture_webview_pixels(
            &self.inner.webview,
            self.inner.width,
            self.inner.height,
        )?;

        #[cfg(target_os = "windows")]
        let (_w, _h, rgba) = capture_windows::capture_webview_pixels(
            &self.inner.webview,
            self.inner.width,
            self.inner.height,
        )?;

        encdr.submit_screen_with_format(
            self.device_id,
            &self.screen_name,
            &rgba,
            PixelFormat::Rgba8888,
        );

        self.inner.clear_frame_ready();
        Ok(())
    }

    /// Check if the WebView has signaled that new content is ready for capture.
    pub fn is_frame_ready(&self) -> bool {
        self.inner.is_frame_ready()
    }

    /// Process pending frames: if the WebView has rendered new content,
    /// capture and submit it to encdr.
    #[cfg(target_os = "macos")]
    pub fn capture_stats(&self) -> capture_macos::CaptureStats {
        self.capture.borrow().stats
    }
    #[cfg(target_os="macos")]
    pub fn set_capture_ink_guard(&self,rect:Option<(u32,u32,u32,u32)>){self.capture.borrow_mut().require_ink=rect;}
    #[cfg(target_os="macos")]
    pub fn set_capture_interval_ms(&self, interval:u64){self.capture.borrow_mut().interval_ms=interval.clamp(16,1000);}

    pub fn poll(&self, encdr: &Encdr) {
        #[cfg(target_os = "macos")]
        {
            if self.inner.replay_loaded(){let mut capture=self.capture.borrow_mut();let guard=capture.require_ink;let interval=capture.interval_ms;*capture=Default::default();capture.require_ink=guard;capture.interval_ms=interval;}
            if !encdr.has_control(self.device_id) || encdr.screen_backlog(self.device_id) >= 2 {
                return;
            }
            // Hidden WebKit pages can throttle JS timers. Keep bounded animation
            // capture bursts on the native clock; never poll indefinitely at idle.
            if self
                .inner
                .animation_until
                .lock()
                .is_ok_and(|until| std::time::Instant::now() < *until)
            {
                if let Ok(mut dirty) = self.inner.frame_ready.lock() {
                    *dirty = true;
                }
            }
            let result = self.capture.borrow_mut().poll(
                &self.inner.webview,
                self.inner.width,
                self.inner.height,
                &self.inner.frame_ready,
            );
            if let Some(result) = result {
                match result {
                    Ok((_, _, rgba)) => {
                        if webview_macos::pipeline_trace_enabled(){
                            use std::hash::{Hash,Hasher};let mut hash=std::collections::hash_map::DefaultHasher::new();rgba.hash(&mut hash);
                            tracing::info!("PIPELINE stage=capture screen={} frame_hash={:016x} frame={} capture_ms={:.3}",self.screen_name,hash.finish(),self.capture_stats().frames,self.capture_stats().last_ms);
                        }
                        encdr.submit_screen_with_format(self.device_id,&self.screen_name,&rgba,PixelFormat::Rgba8888)
                    },
                    Err(error) => {
                        tracing::warn!("Frame capture failed, reloading view: {}", error);
                        if let Err(recovery)=self.inner.recover(){tracing::warn!("View recovery failed: {recovery}");}
                    },
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        if self.is_frame_ready() {
            if let Err(e) = self.capture_and_submit(encdr) {
                tracing::warn!("Frame capture failed: {}", e);
            }
        }
    }

    /// Run one platform event loop for the entire screen session.
    pub fn run_event_loop(tick: impl FnMut()->bool) {
        #[cfg(target_os="macos")]
        {webview_macos::run_event_loop(tick);}
        #[cfg(not(target_os="macos"))]
        {let mut tick=tick;while tick(){if Self::pump_events(){break;}std::thread::sleep(std::time::Duration::from_millis(2));}}
    }

    /// Pump the platform event loop.
    ///
    /// Must be called periodically to allow the WebView to process events
    /// and render. On Linux this drives GTK, on macOS/Windows it drives
    /// the tao event loop.
    pub fn pump_events() -> bool {
        #[cfg(target_os = "linux")]
        {
            gtk::main_iteration_do(false)
        }

        #[cfg(target_os = "macos")]
        {
            webview_macos::pump_events()
        }

        #[cfg(target_os = "windows")]
        {
            webview_windows::pump_events();
            false
        }

        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            false
        }
    }

    /// Load new HTML content into the WebView, replacing the current page.
    pub fn load_html(&self, html: &str) -> Result<(), String> {
        self.inner.load_html(html)
    }

    /// Execute arbitrary JavaScript in the WebView.
    pub fn eval(&self, js: &str) -> Result<(), String> {
        self.inner.eval(js)
    }

    /// Get the device ID this view is attached to.
    pub fn device_id(&self) -> DeviceId {
        self.device_id
    }

    /// Get the screen name this view renders to.
    pub fn screen_name(&self) -> &str {
        &self.screen_name
    }
}

/// A WebView-backed screen renderer for dual-screen devices using a single double-width canvas.
///
/// Manages a single offscreen WebView sized to `(left_width + right_width) x height`.
/// Renders HTML/CSS/JS across the entire dual display surface, automatically captures
/// pixels once per frame, and submits them to encdr's dual-screen pipeline which splits
/// the frame horizontally and updates both displays independently.
pub struct DualScreenView {
    #[cfg(target_os = "linux")]
    inner: webview::ManagedWebView,
    #[cfg(target_os = "macos")]
    inner: webview_macos::ManagedWebView,
    #[cfg(target_os = "windows")]
    inner: webview_windows::ManagedWebView,
    #[cfg(target_os = "macos")]
    capture: std::cell::RefCell<capture_macos::AsyncCapture>,
    device_id: DeviceId,
    left_screen: String,
    right_screen: String,
}

impl DualScreenView {
    /// Create a new double-width WebView renderer for a dual-screen device,
    /// defaulting to screens named `"left"` and `"right"`.
    pub fn new(
        encdr: &Encdr,
        device_id: DeviceId,
        content: ScreenContent,
        visible: bool,
    ) -> Result<Self, String> {
        Self::new_with_screens(encdr, device_id, "left", "right", content, visible)
    }

    /// Create a new double-width WebView renderer specifying custom screen names.
    pub fn new_with_screens(
        encdr: &Encdr,
        device_id: DeviceId,
        left_screen: &str,
        right_screen: &str,
        content: ScreenContent,
        visible: bool,
    ) -> Result<Self, String> {
        let descriptor = encdr
            .device_descriptor(device_id)
            .ok_or_else(|| format!("Device {:?} not connected", device_id))?;

        let left_desc = descriptor
            .screens
            .iter()
            .find(|s| s.name == left_screen)
            .ok_or_else(|| format!("Left screen '{}' not found on device", left_screen))?;

        let right_desc = descriptor
            .screens
            .iter()
            .find(|s| s.name == right_screen)
            .ok_or_else(|| format!("Right screen '{}' not found on device", right_screen))?;

        if left_desc.height != right_desc.height {
            return Err(format!(
                "Left screen height ({}) does not match right screen height ({})",
                left_desc.height, right_desc.height
            ));
        }

        let width = (left_desc.width + right_desc.width) as u32;
        let height = left_desc.height as u32;
        let html = content.to_html()?;

        #[cfg(target_os = "linux")]
        let inner = webview::ManagedWebView::new(width, height, &html, visible)?;

        #[cfg(target_os = "macos")]
        let inner = webview_macos::ManagedWebView::new(width, height, &html, visible)?;

        #[cfg(target_os = "windows")]
        let inner = webview_windows::ManagedWebView::new(width, height, &html, visible)?;

        Ok(Self {
            inner,
            #[cfg(target_os = "macos")]
            capture: std::cell::RefCell::new(capture_macos::AsyncCapture::default()),
            device_id,
            left_screen: left_screen.to_string(),
            right_screen: right_screen.to_string(),
        })
    }

    /// Update the target DeviceId (e.g. after a controller reconnects at a new USB address).
    pub fn set_device_id(&mut self, device_id: DeviceId) {
        self.device_id = device_id;
        #[cfg(target_os = "macos")]
        {
            *self.capture.borrow_mut() = capture_macos::AsyncCapture::default();
        }
    }

    /// Push a state update to the WebView.
    ///
    /// Calls `window.encdr.onMessage(channel, data)` in the WebView's JS context.
    pub fn send(&self, channel: &str, data: Value) {
        #[cfg(target_os="macos")]
        if webview_macos::pipeline_trace_enabled(){tracing::info!("PIPELINE stage=webview_send screen={} state_seq={} latest_input_seq={}","dual",data["traceStateSeq"],data["traceInputSeq"]);}
        let js = bridge::build_send_js(channel, &data);
        if let Err(e) = self.inner.eval(&js) {
            tracing::warn!("Failed to send to WebView: {}", e);
        }
    }

    /// Capture the current double-width WebView contents and submit to encdr for USB transfer.
    ///
    /// Does nothing while another client (e.g. NI's software) has the
    /// hardware; a pending frame stays flagged, so the next call after
    /// control returns captures the page as it is then.
    pub fn capture_and_submit(&self, encdr: &Encdr) -> Result<(), String> {
        if !encdr.has_control(self.device_id) {
            tracing::trace!("Skipping WebView capture: another application has the hardware");
            return Ok(());
        }

        #[cfg(target_os = "linux")]
        let (_w, _h, rgba) = capture::capture_webview_pixels(
            &self.inner.webkit_view,
            self.inner.width,
            self.inner.height,
        )?;

        #[cfg(target_os = "macos")]
        let (_w, _h, rgba) = capture_macos::capture_webview_pixels(
            &self.inner.webview,
            self.inner.width,
            self.inner.height,
        )?;

        #[cfg(target_os = "windows")]
        let (_w, _h, rgba) = capture_windows::capture_webview_pixels(
            &self.inner.webview,
            self.inner.width,
            self.inner.height,
        )?;

        encdr.submit_dual_screen_with_format(
            self.device_id,
            &self.left_screen,
            &self.right_screen,
            &rgba,
            PixelFormat::Rgba8888,
        );

        self.inner.clear_frame_ready();
        Ok(())
    }

    /// Check if the WebView has signaled that new content is ready for capture.
    pub fn is_frame_ready(&self) -> bool {
        self.inner.is_frame_ready()
    }

    /// Process pending frames: if the WebView has rendered new content,
    /// capture and submit it to encdr.
    #[cfg(target_os = "macos")]
    pub fn capture_stats(&self) -> capture_macos::CaptureStats {
        self.capture.borrow().stats
    }
    pub fn poll(&self, encdr: &Encdr) {
        #[cfg(target_os = "macos")]
        {
            if !encdr.has_control(self.device_id) || encdr.screen_backlog(self.device_id) >= 2 {
                return;
            }
            // Hidden WebKit pages can throttle JS timers. Keep bounded animation
            // capture bursts on the native clock; never poll indefinitely at idle.
            if self
                .inner
                .animation_until
                .lock()
                .is_ok_and(|until| std::time::Instant::now() < *until)
            {
                if let Ok(mut dirty) = self.inner.frame_ready.lock() {
                    *dirty = true;
                }
            }
            let result = self.capture.borrow_mut().poll(
                &self.inner.webview,
                self.inner.width,
                self.inner.height,
                &self.inner.frame_ready,
            );
            if let Some(result) = result {
                match result {
                    Ok((_, _, rgba)) => encdr.submit_dual_screen_with_format(
                        self.device_id,
                        &self.left_screen,
                        &self.right_screen,
                        &rgba,
                        PixelFormat::Rgba8888,
                    ),
                    Err(error) => tracing::warn!("Frame capture failed: {}", error),
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        if self.is_frame_ready() {
            if let Err(e) = self.capture_and_submit(encdr) {
                tracing::warn!("Frame capture failed: {}", e);
            }
        }
    }

    /// Load new HTML content into the WebView, replacing the current page.
    pub fn load_html(&self, html: &str) -> Result<(), String> {
        self.inner.load_html(html)
    }

    /// Execute arbitrary JavaScript in the WebView.
    pub fn eval(&self, js: &str) -> Result<(), String> {
        self.inner.eval(js)
    }

    /// Get the device ID this view is attached to.
    pub fn device_id(&self) -> DeviceId {
        self.device_id
    }

    /// Get the left screen name this view renders to.
    pub fn left_screen_name(&self) -> &str {
        &self.left_screen
    }

    /// Get the right screen name this view renders to.
    pub fn right_screen_name(&self) -> &str {
        &self.right_screen
    }
}
