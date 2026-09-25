//! The floating focus bar: a small always-on-top window that shows and controls the timer
//! while you work in other applications.
//!
//! Authority: the main window's renderer is the only writer of timer state (SQLite). The bar
//! renders state the main window sends it and sends commands back; its capability grants it
//! no database or file commands at all.
//!
//! Rust owns the bar's lifecycle and geometry:
//!  - It is created when shown and destroyed when hidden. Windows only shows a window without
//!    activating it on its first show, so recreating it keeps every show from stealing
//!    keyboard focus from the app you are working in.
//!  - Its position is remembered in `focusbar.json` in the data directory and always kept
//!    inside a monitor's work area (never over the taskbar or dock), including after monitors
//!    are added, removed or rescaled.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

use crate::error::{Error, Result};

pub const LABEL: &str = "focusbar";
const FILE: &str = "focusbar.json";
/// Logical size of the bar.
const WIDTH: f64 = 440.0;
const HEIGHT: f64 = 52.0;
/// Logical gap between the default position and the bottom of the work area.
const MARGIN: f64 = 24.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn overlap(&self, o: &Rect) -> i64 {
        let w = (self.x + self.w).min(o.x + o.w) - self.x.max(o.x);
        let h = (self.y + self.h).min(o.y + o.h) - self.y.max(o.y);
        if w <= 0 || h <= 0 {
            0
        } else {
            w as i64 * h as i64
        }
    }

    fn contains(&self, o: &Rect) -> bool {
        o.x >= self.x
            && o.y >= self.y
            && o.x + o.w <= self.x + self.w
            && o.y + o.h <= self.y + self.h
    }
}

/// Where the bar goes: inside the work area it overlaps most (clamped fully inside it), or,
/// if it is on no monitor at all (or has no saved position), at the bottom centre of
/// `fallback`. Coordinates are physical pixels.
pub fn place(
    saved: Option<(i32, i32)>,
    size: (i32, i32),
    areas: &[Rect],
    fallback: usize,
    margin: i32,
) -> (i32, i32) {
    let (w, h) = size;
    if areas.is_empty() {
        return saved.unwrap_or((0, 0));
    }
    let clamp_into = |a: &Rect, x: i32, y: i32| {
        let x = x.min(a.x + a.w - w).max(a.x);
        let y = y.min(a.y + a.h - h).max(a.y);
        (x, y)
    };
    if let Some((x, y)) = saved {
        let rect = Rect { x, y, w, h };
        if let Some(best) = areas
            .iter()
            .filter(|a| a.overlap(&rect) > 0)
            .max_by_key(|a| a.overlap(&rect))
        {
            return clamp_into(best, x, y);
        }
    }
    let a = &areas[fallback.min(areas.len() - 1)];
    clamp_into(a, a.x + (a.w - w) / 2, a.y + a.h - h - margin)
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Saved {
    /// Physical top-left position, or None for the default spot.
    position: Option<(i32, i32)>,
    /// Whether the bar was showing when Keel last exited (restored if a timer is running).
    visible: bool,
}

pub struct FocusBar {
    path: PathBuf,
    saved: Mutex<Saved>,
    moves: AtomicU64,
    /// Set when the user starts dragging the bar. Window systems also report moves while they
    /// create and place a window (e.g. 0,0); only moves from a user drag are remembered.
    dragging: AtomicBool,
    /// Held while the bar window is looked up or created: two quick show requests (timer
    /// start and Focus mode) must not both build a window, since labels are only registered
    /// once a window exists.
    creating: Mutex<()>,
}

impl FocusBar {
    pub fn new(data_dir: &std::path::Path) -> Self {
        let path = data_dir.join(FILE);
        let saved = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            saved: Mutex::new(saved),
            moves: AtomicU64::new(0),
            dragging: AtomicBool::new(false),
            creating: Mutex::new(()),
        }
    }

    fn update(&self, f: impl FnOnce(&mut Saved)) {
        let snapshot = {
            let mut s = self.saved.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut s);
            s.clone()
        };
        if let Ok(json) = serde_json::to_string(&snapshot) {
            let _ = std::fs::write(&self.path, json);
        }
    }

    fn get(&self) -> Saved {
        self.saved.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// "Delete all data": back to the default position, and forget the saved file.
    pub fn forget(&self) {
        *self.saved.lock().unwrap_or_else(|e| e.into_inner()) = Saved::default();
        let _ = std::fs::remove_file(&self.path);
    }

    pub fn was_visible(&self) -> bool {
        self.get().visible
    }
}

fn work_areas<R: Runtime>(window: &WebviewWindow<R>) -> (Vec<Rect>, usize) {
    let monitors = window.available_monitors().unwrap_or_default();
    let areas: Vec<Rect> = monitors
        .iter()
        .map(|m| {
            let a = m.work_area();
            Rect {
                x: a.position.x,
                y: a.position.y,
                w: a.size.width as i32,
                h: a.size.height as i32,
            }
        })
        .collect();
    // Default to the monitor the main window is on, else the primary monitor.
    let anchor = window
        .app_handle()
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let fallback = anchor
        .and_then(|a| monitors.iter().position(|m| m.position() == a.position()))
        .unwrap_or(0);
    (areas, fallback)
}

/// Moves the bar fully onto a monitor's work area if it is not already.
fn keep_on_screen<R: Runtime>(window: &WebviewWindow<R>, bar: &FocusBar, force_default: bool) {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let (areas, fallback) = work_areas(window);
    let rect = Rect {
        x: pos.x,
        y: pos.y,
        w: size.width as i32,
        h: size.height as i32,
    };
    if !force_default && areas.iter().any(|a| a.contains(&rect)) {
        return;
    }
    let margin = (MARGIN * window.scale_factor().unwrap_or(1.0)).round() as i32;
    let saved = if force_default {
        None
    } else {
        Some((pos.x, pos.y))
    };
    let (x, y) = place(saved, (rect.w, rect.h), &areas, fallback, margin);
    if (x, y) != (pos.x, pos.y) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    if !force_default {
        bar.update(|s| s.position = Some((x, y)));
    }
}

pub fn show<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let bar = app.state::<FocusBar>();
    let _creating = bar.creating.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(window) = app.get_webview_window(LABEL) {
        keep_on_screen(&window, &bar, false);
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("focusbar.html".into()));
    // WebView2 shares one browser process per data folder, and only between webviews created
    // with the same options: use the main window's configured browser arguments, if any.
    let main_args = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .and_then(|w| w.additional_browser_args.clone());
    let builder = match main_args {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    };
    let window = linux_sizing(builder)
        .title("Keel focus bar")
        .inner_size(WIDTH, HEIGHT)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .shadow(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        // Never take keyboard focus when appearing; it stays focusable for clicks and Tab.
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| Error::msg(format!("could not open the focus bar: {e}")))?;

    // Before it is shown, GTK reports a 1×1 window, so size it from the logical dimensions.
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.outer_size().map_err(|e| Error::msg(e.to_string()))?;
    let w = (size.width as i32).max((WIDTH * scale).round() as i32);
    let h = (size.height as i32).max((HEIGHT * scale).round() as i32);
    let (areas, fallback) = work_areas(&window);
    let margin = (MARGIN * scale).round() as i32;
    let (x, y) = place(bar.get().position, (w, h), &areas, fallback, margin);
    bar.dragging.store(false, Ordering::SeqCst);
    let _ = window.set_position(PhysicalPosition::new(x, y));

    let handle = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(p) => {
            let bar = handle.state::<FocusBar>();
            if !bar.dragging.load(Ordering::SeqCst) {
                return;
            }
            bar.update(|s| s.position = Some((p.x, p.y)));
            // Once dragging settles, pull the bar back if it was left partly off-screen.
            let generation = bar.moves.fetch_add(1, Ordering::SeqCst) + 1;
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(700)).await;
                let bar = handle.state::<FocusBar>();
                if bar.moves.load(Ordering::SeqCst) == generation {
                    if let Some(w) = handle.get_webview_window(LABEL) {
                        keep_on_screen(&w, &bar, false);
                        repaint_linux(&w).await;
                    }
                }
            });
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            if let Some(w) = handle.get_webview_window(LABEL) {
                keep_on_screen(&w, &handle.state::<FocusBar>(), false);
            }
        }
        _ => {}
    });

    window
        .show()
        .map_err(|e| Error::msg(format!("could not show the focus bar: {e}")))?;
    bar.update(|s| s.visible = true);
    let w = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        repaint_linux(&w).await;
    });
    Ok(())
}

/// Linux sizing. GTK sizes a non-resizable window to its content's natural size, which is
/// empty for a web view (GTK then picks 200×200), so the window is resizable with its size
/// pinned by constraints. One extra pixel of height is allowed for `repaint_linux`.
#[cfg(target_os = "linux")]
fn linux_sizing<R: Runtime, M: Manager<R>>(
    b: WebviewWindowBuilder<'_, R, M>,
) -> WebviewWindowBuilder<'_, R, M> {
    b.resizable(true)
        .min_inner_size(WIDTH, HEIGHT)
        .max_inner_size(WIDTH, HEIGHT + 1.0)
}

#[cfg(not(target_os = "linux"))]
fn linux_sizing<R: Runtime, M: Manager<R>>(
    b: WebviewWindowBuilder<'_, R, M>,
) -> WebviewWindowBuilder<'_, R, M> {
    b.resizable(false)
}

/// On an X server without a compositor, WebKitGTK leaves a window created at runtime black
/// after it has been moved, until its size changes. A one-pixel size change and back makes
/// it repaint. (With a compositor, as on standard GNOME/KDE/Xfce desktops, this is a no-op.)
#[cfg(target_os = "linux")]
async fn repaint_linux<R: Runtime>(w: &WebviewWindow<R>) {
    use tauri::LogicalSize;
    let _ = w.set_size(LogicalSize::new(WIDTH, HEIGHT + 1.0));
    tokio::time::sleep(Duration::from_millis(60)).await;
    let _ = w.set_size(LogicalSize::new(WIDTH, HEIGHT));
}

#[cfg(not(target_os = "linux"))]
async fn repaint_linux<R: Runtime>(_w: &WebviewWindow<R>) {}

/// Starts a user drag of the bar (called from the bar when its surface is pressed).
pub fn start_drag<R: Runtime>(window: &WebviewWindow<R>) -> Result<()> {
    window
        .app_handle()
        .state::<FocusBar>()
        .dragging
        .store(true, Ordering::SeqCst);
    window
        .start_dragging()
        .map_err(|e| Error::msg(format!("could not move the focus bar: {e}")))
}

/// Hides the bar (by destroying it). The timer is not affected.
pub fn hide<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    app.state::<FocusBar>().update(|s| s.visible = false);
    if let Some(window) = app.get_webview_window(LABEL) {
        window
            .destroy()
            .map_err(|e| Error::msg(format!("could not hide the focus bar: {e}")))?;
    }
    Ok(())
}

pub fn is_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(LABEL).is_some()
}

pub fn reset_position<R: Runtime>(app: &AppHandle<R>) {
    let bar = app.state::<FocusBar>();
    bar.update(|s| s.position = None);
    if let Some(window) = app.get_webview_window(LABEL) {
        keep_on_screen(&window, &bar, true);
    }
}

/// Brings the main window forward (unminimized and focused) without changing its view.
pub fn focus_main<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| Error::msg("the main window is not open"))?;
    let _ = main.unminimize();
    let _ = main.show();
    main.set_focus()
        .map_err(|e| Error::msg(format!("could not focus Keel: {e}")))
}

/// Keeps the bar on a visible monitor when displays change (connected, removed, rearranged)
/// without a move event reaching the bar.
pub fn watch_displays<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if let Some(w) = app.get_webview_window(LABEL) {
                keep_on_screen(&w, &app.state::<FocusBar>(), false);
            }
        }
    });
}

/// Called when the main window closes: close the bar too (so Keel exits), but remember that
/// it was showing so it can come back with a still-running timer next time.
pub fn close_with_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Rect = Rect {
        x: 0,
        y: 0,
        w: 1920,
        h: 1040,
    }; // 40px taskbar below
    const RIGHT: Rect = Rect {
        x: 1920,
        y: -200,
        w: 2560,
        h: 1400,
    };

    #[test]
    fn default_position_is_bottom_centre_above_the_taskbar() {
        assert_eq!(
            place(None, (440, 52), &[LAPTOP], 0, 24),
            (740, 1040 - 52 - 24)
        );
        assert_eq!(
            place(None, (440, 52), &[LAPTOP, RIGHT], 1, 24),
            (1920 + 1060, -200 + 1400 - 52 - 24)
        );
    }

    #[test]
    fn a_saved_position_on_screen_is_kept() {
        assert_eq!(
            place(Some((100, 200)), (440, 52), &[LAPTOP, RIGHT], 0, 24),
            (100, 200)
        );
        assert_eq!(
            place(Some((2000, -150)), (440, 52), &[LAPTOP, RIGHT], 0, 24),
            (2000, -150)
        );
    }

    #[test]
    fn partly_off_screen_is_pulled_inside_the_monitor_it_mostly_covers() {
        // Hanging off the right edge of the laptop with no monitor there.
        assert_eq!(
            place(Some((1700, 500)), (440, 52), &[LAPTOP], 0, 24),
            (1920 - 440, 500)
        );
        // Over the taskbar: moved up into the work area.
        assert_eq!(
            place(Some((300, 1030)), (440, 52), &[LAPTOP], 0, 24),
            (300, 1040 - 52)
        );
        // Straddling two monitors: goes to the one with more overlap.
        assert_eq!(
            place(Some((1800, 100)), (440, 52), &[LAPTOP, RIGHT], 0, 24),
            (1920, 100)
        );
    }

    #[test]
    fn a_position_on_a_disconnected_monitor_falls_back_to_the_default() {
        // The right monitor was unplugged.
        assert_eq!(
            place(Some((3000, 300)), (440, 52), &[LAPTOP], 0, 24),
            (740, 964)
        );
        assert_eq!(place(Some((0, 0)), (440, 52), &[], 0, 24), (0, 0));
    }

    #[test]
    fn remembers_position_and_visibility_across_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let bar = FocusBar::new(dir.path());
        assert!(!bar.was_visible());
        bar.update(|s| {
            s.position = Some((12, 34));
            s.visible = true;
        });
        let again = FocusBar::new(dir.path());
        assert!(again.was_visible());
        assert_eq!(again.get().position, Some((12, 34)));
        std::fs::write(dir.path().join(FILE), "not json").unwrap();
        assert_eq!(
            FocusBar::new(dir.path()).get().position,
            None,
            "corrupt file is ignored"
        );
    }
}
