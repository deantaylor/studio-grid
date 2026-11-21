// Modified 2026-11-11: see ../PATCHES.md (GPL-3.0-or-later).
//! macOS pixel capture via WKWebView's native takeSnapshot API.
//!
//! Uses objc2 to call WKWebView.takeSnapshot(with:completionHandler:)
//! and extracts RGBA pixel data from the resulting NSImage via NSBitmapImageRep.

use std::sync::mpsc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, ClassType};
use objc2_app_kit::{NSBitmapImageRep, NSImage};
use objc2_foundation::NSError;
use wry::WebViewExtMacOS;

use super::webview_macos;
pub type CapturedPixels = (u32, u32, Vec<u8>);
pub type CaptureResult = Result<CapturedPixels, String>;

/// Capture the current WebView contents as RGBA pixel data at the specified dimensions.
///
/// Uses WKWebView's native `takeSnapshot(with:completionHandler:)` which captures
/// the full composited output (HTML, CSS, Canvas, SVG). The snapshot is taken at
/// the WebView's current size and scaled to the target dimensions if needed.
pub struct PendingSnapshot {
    receiver: mpsc::Receiver<Result<Retained<NSImage>, String>>,
    started: std::time::Instant,
}
impl PendingSnapshot {
    pub fn begin(webview: &wry::WebView) -> Self {
        let started = std::time::Instant::now();
        let wk_webview = webview.webview();

        let (tx, rx) = mpsc::channel::<Result<Retained<NSImage>, String>>();

        // Create the completion handler block:
        // ^(NSImage *snapshotImage, NSError *error)
        let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            if !image.is_null() {
                let retained: Retained<NSImage> =
                    unsafe { Retained::retain(image) }.expect("Failed to retain NSImage");
                let _ = tx.send(Ok(retained));
            } else {
                let msg = if !error.is_null() {
                    let err: &NSError = unsafe { &*error };
                    format!("WKWebView snapshot failed: {:?}", err)
                } else {
                    "WKWebView snapshot failed: unknown error".to_string()
                };
                let _ = tx.send(Err(msg));
            }
        });

        // Capture the composited result after pending layout/paint updates.
        unsafe {
            let configuration = objc2_web_kit::WKSnapshotConfiguration::new(
                objc2::MainThreadMarker::new().expect("WebView snapshot on main thread"),
            );
            configuration.setAfterScreenUpdates(true);
            wk_webview
                .takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &block);
        }

        Self {
            receiver: rx,
            started,
        }
    }
    pub fn poll(&self, width: u32, height: u32) -> Option<CaptureResult> {
        match self.receiver.try_recv() {
            Ok(result) => {
                Some(result.and_then(|image| extract_rgba_from_nsimage(&image, width, height)))
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                Some(Err("Snapshot callback channel disconnected".into()))
            }
            Err(mpsc::TryRecvError::Empty)
                if self.started.elapsed() > std::time::Duration::from_millis(1500) =>
            {
                Some(Err("WKWebView snapshot timed out after 1500ms".into()))
            }
            Err(mpsc::TryRecvError::Empty) => None,
        }
    }
    pub fn elapsed_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub struct CaptureStats {
    pub frames: u64,
    pub last_ms: f64,
    pub max_ms: f64,
}
#[derive(Default)]
pub struct AsyncCapture {
    pending: Option<PendingSnapshot>,
    last_started: Option<std::time::Instant>,
    pub require_ink: Option<(u32,u32,u32,u32)>,
    pub interval_ms: u64,
    pub stats: CaptureStats,
}
impl AsyncCapture {
    pub fn poll(
        &mut self,
        webview: &wry::WebView,
        width: u32,
        height: u32,
        ready: &std::sync::Mutex<bool>,
    ) -> Option<CaptureResult> {
        if self.pending.is_none() {
            // Coalesce to a stable cadence instead of snapshot bursts competing
            // with state updates. Keep the newest dirty state until this slot.
            if self.last_started.is_some_and(|last| last.elapsed() < std::time::Duration::from_millis(if self.interval_ms == 0 {33} else {self.interval_ms.clamp(16,1000)})) {
                return None;
            }
            let mut dirty = ready.lock().ok()?;
            if !*dirty {
                return None;
            }
            // Consume before starting. A newer render while in flight stays dirty.
            *dirty = false;
            self.last_started = Some(std::time::Instant::now());
            let _ = webview.evaluate_script(super::bridge::ADVANCE_JS);
            self.pending = Some(PendingSnapshot::begin(webview));
        }
        let pending = self.pending.as_ref()?;
        let result = pending.poll(width, height)?.and_then(|frame| {
            if let Some(rect)=self.require_ink {validate_ink(&frame.2,width,height,rect)?;}
            Ok(frame)
        });
        let elapsed = pending.elapsed_ms();
        self.pending = None;
        if result.is_err() {
            if let Ok(mut dirty)=ready.lock(){*dirty=true;}
        }
        if result.is_ok() {
            self.stats.frames += 1;
            self.stats.last_ms = elapsed;
            self.stats.max_ms = self.stats.max_ms.max(elapsed);
        }
        Some(result)
    }
}

fn validate_ink(pixels:&[u8],width:u32,height:u32,(x,y,w,h):(u32,u32,u32,u32))->Result<(),String>{
    let mut count=0;
    for row in y..y.saturating_add(h).min(height) {for col in x..x.saturating_add(w).min(width) {
        let offset=((row*width+col)*4) as usize;
        if pixels.get(offset..offset+3).is_some_and(|rgb|rgb.iter().any(|v|*v>60)) {count+=1;if count>=3{return Ok(());}}
    }}
    Err("Blank header/list capture rejected; retaining the last panel image".into())
}

#[cfg(test)]
mod guard_tests {
    #[test]
    fn alert_frame_needs_centre_guard_but_blank_frames_still_fail(){
        let mut pixels=vec![20;480*272*4];let broad=(8,8,464,256);
        assert!(super::validate_ink(&pixels,480,272,broad).is_err());
        for x in 220usize..223 {let offset=(136*480+x)*4;pixels[offset..offset+3].fill(200);}
        assert!(super::validate_ink(&pixels,480,272,(20,11,400,32)).is_err());
        assert!(super::validate_ink(&pixels,480,272,broad).is_ok());
    }
    #[test]
    fn guard_accepts_saturated_slot_ink_and_rejects_dark_frames(){
        let region=(20,11,400,32);
        for colour in [[255,0,0],[0,255,0],[255,130,0],[255,255,0]] {
            let mut pixels=vec![20;480*272*4];
            assert!(super::validate_ink(&pixels,480,272,region).is_err());
            for x in 60usize..63 {let offset=(20*480+x)*4;pixels[offset..offset+3].copy_from_slice(&colour);}
            assert!(super::validate_ink(&pixels,480,272,region).is_ok(),"{colour:?}");
        }
    }
    #[test]
    fn guard_rejects_missing_list_even_when_slot_and_voice_counter_remain() {
        let mut pixels=vec![20;480*272*4];
        for x in [20usize,21,437,438]{let offset=(20*480+x)*4;pixels[offset..offset+3].fill(255);}
        let region=(58,11,362,32);
        assert!(super::validate_ink(&pixels,480,272,region).is_err());
        for x in 60usize..63 {let offset=(20*480+x)*4;pixels[offset..offset+3].fill(255);}
        assert!(super::validate_ink(&pixels,480,272,region).is_ok());
    }
}

pub fn capture_webview_pixels(
    webview: &wry::WebView,
    width: u32,
    height: u32,
) -> Result<(u32, u32, Vec<u8>), String> {
    let capture = PendingSnapshot::begin(webview);
    loop {
        if let Some(result) = capture.poll(width, height) {
            return result;
        }
        webview_macos::pump_events();
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

/// Extract RGBA pixels from an NSImage at the target dimensions.
///
/// Creates an NSBitmapImageRep from the NSImage's TIFF representation,
/// then reads the raw pixel data. Handles premultiplied alpha conversion.
fn extract_rgba_from_nsimage(
    ns_image: &NSImage,
    target_width: u32,
    target_height: u32,
) -> Result<(u32, u32, Vec<u8>), String> {
    unsafe {
        // WK snapshots commonly already contain an RGBA bitmap. Reuse it
        // rather than encoding and decoding a TIFF on every completed frame.
        // Other layouts retain the existing conversion path.
        let representations: *mut AnyObject = msg_send![ns_image, representations];
        let count: usize = msg_send![representations, count];
        let mut bitmap_rep: Option<Retained<NSBitmapImageRep>> = None;
        for index in 0..count {
            let rep: *mut AnyObject = msg_send![representations, objectAtIndex: index];
            let bitmap: bool = msg_send![rep, isKindOfClass: NSBitmapImageRep::class()];
            if bitmap {
                let bits: isize = msg_send![rep, bitsPerSample];
                let samples: isize = msg_send![rep, samplesPerPixel];
                let format: usize = msg_send![rep, bitmapFormat];
                let planar: bool = msg_send![rep, isPlanar];
                if bits == 8 && samples == 4 && format & !2 == 0 && !planar {
                    bitmap_rep = Retained::retain(rep.cast::<NSBitmapImageRep>());
                    break;
                }
            }
        }
        let bitmap_rep = match bitmap_rep {
            Some(rep) => rep,
            None => {
                let tiff_data: *mut AnyObject = msg_send![ns_image, TIFFRepresentation];
                if tiff_data.is_null() {
                    return Err("NSImage TIFFRepresentation returned nil".to_string());
                }
                let rep: Option<Retained<NSBitmapImageRep>> =
                    msg_send![NSBitmapImageRep::class(), imageRepWithData: tiff_data];
                rep.ok_or("Failed to create NSBitmapImageRep from TIFF data")?
            }
        };

        // Read dimensions and pixel data
        let src_width: isize = msg_send![&bitmap_rep, pixelsWide];
        let src_height: isize = msg_send![&bitmap_rep, pixelsHigh];
        let bytes_per_row: isize = msg_send![&bitmap_rep, bytesPerRow];
        let samples_per_pixel: isize = msg_send![&bitmap_rep, samplesPerPixel];
        let bitmap_data: *const u8 = msg_send![&bitmap_rep, bitmapData];

        if bitmap_data.is_null() || src_width <= 0 || src_height <= 0 {
            return Err(format!(
                "Invalid bitmap: {}x{}, data null={}",
                src_width,
                src_height,
                bitmap_data.is_null()
            ));
        }

        let has_alpha = samples_per_pixel >= 4;
        let w = target_width;
        let h = target_height;
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);

        if samples_per_pixel==4 && src_width as u32==w && src_height as u32==h {
            for y in 0..h {rgba.extend_from_slice(std::slice::from_raw_parts(bitmap_data.add(y as usize*bytes_per_row as usize),w as usize*4));}
            return Ok((w,h,rgba));
        }
        if samples_per_pixel==4 && src_width as u32==w*2 && src_height as u32==h*2 {
            // Average all four Retina samples, retaining the antialiased edge.
            // Nearest-neighbor sampling discarded three quarters of the glyph.
            for y in 0..h {
                let top=bitmap_data.add(y as usize*2*bytes_per_row as usize);
                let bottom=top.add(bytes_per_row as usize);
                for x in 0..w {let offset=x as usize*8;
                    for channel in 0..4 {let i=offset+channel;
                        let total=u16::from(*top.add(i))+u16::from(*top.add(i+4))+u16::from(*bottom.add(i))+u16::from(*bottom.add(i+4));
                        rgba.push(((total+2)/4) as u8);
                    }
                }
            }
            return Ok((w,h,rgba));
        }
        // Scale if source differs from target (e.g. Retina)
        let sx = src_width as f64 / w as f64;
        let sy = src_height as f64 / h as f64;

        for y in 0..h {
            for x in 0..w {
                // Nearest-neighbor sampling from source
                let src_x = ((x as f64 * sx) as usize).min(src_width as usize - 1);
                let src_y = ((y as f64 * sy) as usize).min(src_height as usize - 1);
                let offset = src_y * bytes_per_row as usize + src_x * samples_per_pixel as usize;

                // NSBitmapImageRep with TIFF source is typically RGBA (non-premultiplied)
                let r = *bitmap_data.add(offset);
                let g = *bitmap_data.add(offset + 1);
                let b = *bitmap_data.add(offset + 2);
                let a = if has_alpha {
                    *bitmap_data.add(offset + 3)
                } else {
                    255
                };

                rgba.push(r);
                rgba.push(g);
                rgba.push(b);
                rgba.push(a);
            }
        }

        Ok((w, h, rgba))
    }
}
