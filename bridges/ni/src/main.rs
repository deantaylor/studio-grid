mod controls;

use controls::{Controls, Profile, DISPLAY_BUTTONS};
use encdr::{ControllerFilter, DeviceDescriptor, DeviceId, Encdr, EncdrConfig, Event, LedValue};
use encdr_view::webview_macos::{run_event_loop_with_target, PreviewWindow};
use encdr_view::{ScreenContent, ScreenView};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    error::Error,
    io::{self, BufRead, Write},
    sync::mpsc,
    thread,
};

const PANEL: &str = include_str!("../panel.html");

fn slot(name: &str, prefix: &str) -> Option<usize> {
    let number = name.strip_prefix(prefix)?.parse().ok()?;
    (1..=8).contains(&number).then_some(number)
}

fn send_input(input: Value) -> bool {
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{input}")
        .and_then(|_| stdout.flush())
        .is_ok()
}

const SCREEN_SIZE: (u32, u32) = (480, 272);

fn supports_displays(device: &DeviceDescriptor) -> bool {
    let Some(service) = &device.quirks.ni_service else {
        return false;
    };
    device.vendor_id.0 == 0x17cc
        && ["left", "right"].iter().all(|side| {
            device.screens.iter().any(|screen| {
                screen.name == *side
                    && screen.interface == service.screen_interface
                    && (u32::from(screen.width), u32::from(screen.height)) == SCREEN_SIZE
            })
        })
}

fn send_device_input(id: DeviceId, mut input: Value) -> bool {
    input["device"] = json!(id.to_string());
    send_input(input)
}

struct Displays([ScreenView; 2]);

impl Displays {
    fn new(
        preview_only: bool,
        mut make_screen: impl FnMut(&str, ScreenContent) -> Result<ScreenView, String>,
    ) -> Result<Self, String> {
        let mut screen = |side| {
            let html = PANEL.replace("__SIDE__", side).replace(
                "__PREVIEW_ONLY__",
                if preview_only { "true" } else { "false" },
            );
            make_screen(side, ScreenContent::Html(html))
        };
        Ok(Self([screen("left")?, screen("right")?]))
    }

    fn send(&self, state: Value) {
        self.0[0].send("state", state.clone());
        self.0[1].send("state", state);
    }

    fn poll(&self, encdr: &Encdr) {
        for screen in &self.0 {
            screen.poll(encdr);
        }
    }
}

#[derive(Default)]
struct Surface {
    owned: bool,
    displays: Option<Displays>,
    controls: Controls,
    lamps: HashMap<&'static str, LedValue>,
    knob_remainders: [f64; 8],
    dirty: bool,
}

impl Surface {
    fn input(
        &mut self,
        profile: Profile,
        event: Event,
        active_page: u64,
        active_slot: Option<usize>,
    ) -> Option<Value> {
        let Self {
            controls,
            dirty,
            knob_remainders,
            ..
        } = self;
        Some(match event {
            Event::Button { name, pressed, .. }
                if profile.buttons().any(|button| button == name)
                    || name == profile.dial_press()
                    || profile.dial_directions().contains(&name) =>
            {
                *dirty = true;
                let previous_setup = controls.track_setup_page();
                let action = controls.button(profile, name, pressed);
                let setup_pressed = action
                    .as_ref()
                    .and_then(|action| action["slot"].as_u64())
                    .is_some_and(|slot| {
                        controls.track_button_pressed(slot as usize, active_slot, active_page)
                    });
                if previous_setup != controls.track_setup_page() {
                    knob_remainders[..4].fill(0.0);
                }
                if setup_pressed {
                    return None;
                }
                action?
            }
            Event::Encoder { name, delta, .. } if name == profile.dial => {
                controls.dial_turn(delta)?
            }
            Event::EncoderFine { name, delta, .. }
                if !controls.launcher_active && delta.is_finite() =>
            {
                let knob = slot(name, profile.knob_prefix)?;
                let setup_page = controls.track_setup_page();
                if setup_page.is_some() && knob == 2 {
                    return None;
                }
                let remainder = &mut knob_remainders[knob - 1];
                let resolution = if knob <= 2 && setup_page.is_none() {
                    0.01
                } else {
                    0.04
                };
                *remainder += f64::from(delta);
                let steps = (*remainder / resolution).trunc() as i32;
                if steps == 0 {
                    return None;
                }
                *remainder -= f64::from(steps) * resolution;
                json!({ "kind": "knob", "knob": knob, "steps": steps.clamp(-64, 64), "setupPage": setup_page })
            }
            _ => return None,
        })
    }

    fn update(&mut self, previous: &Value, state: &Value) {
        self.dirty |= previous != state;
        let launcher_active = state["patternLauncherActive"] == true;
        if state["page"] != previous["page"]
            || state["parameters"][4]["value"] != previous["parameters"][4]["value"]
            || launcher_active != self.controls.launcher_active
        {
            self.controls.clear_confirm = false;
        }
        self.controls.launcher_active = launcher_active;
        self.controls.update_note_edit(&state["noteEdit"]);
    }

    fn update_lamps(
        &mut self,
        encdr: &Encdr,
        id: DeviceId,
        profile: Profile,
        state: &Value,
        track_activity: u8,
    ) {
        let controls = &self.controls;
        let colors = controls.display_button_colors(profile, state);
        for name in profile.lamp_buttons() {
            let value =
                if let Some(index) = DISPLAY_BUTTONS.iter().position(|button| *button == name) {
                    controls.display_lamp(profile, index, colors[index], state, track_activity)
                } else if profile.launcher == Some(name) && controls.launcher_active {
                    profile.lamp(name, true)
                } else {
                    controls.lamp(profile, name)
                };
            if self.lamps.insert(name, value) != Some(value) {
                encdr.set_led(id, name, value);
            }
        }
    }

    fn render(
        &mut self,
        encdr: &Encdr,
        id: DeviceId,
        state: &Value,
        active_page: u64,
        active_slot: Option<usize>,
        track_activity: u8,
        preview: Option<&Displays>,
    ) {
        let Some(displays) = &self.displays else {
            return;
        };
        if let Some(profile) = Profile::for_product(id.product_id()) {
            if self
                .controls
                .update_track_setup(profile, active_page, active_slot)
            {
                self.knob_remainders[..4].fill(0.0);
                self.dirty = true;
            }
            if self.dirty && !state.is_null() {
                let controls = &self.controls;
                let mut view = state.clone();
                view["selector"] = json!(controls.mode(profile));
                view["trackSetup"] = json!(controls.track_setup_page().is_some());
                view["buttonColors"] = json!(controls.display_button_colors(profile, state));
                view["clearHeld"] = json!(controls.clear_held(profile));
                view["clearConfirm"] = json!(controls.clear_confirm);
                if let Some(preview) = preview {
                    preview.send(view.clone());
                }
                displays.send(view);
                self.update_lamps(encdr, id, profile, state, track_activity);
            }
        } else if self.dirty && !state.is_null() {
            send_track_view(displays, state);
            if let Some(preview) = preview {
                send_track_view(preview, state);
            }
        }
        self.dirty = false;
        if let Some(displays) = &self.displays {
            displays.poll(encdr);
        }
    }
}

fn send_track_view(displays: &Displays, state: &Value) {
    let mut view = state.clone();
    view["selector"] = json!("track");
    displays.send(view);
}

fn main() -> Result<(), Box<dyn Error>> {
    // Register in the NI instance menu even when raw USB screens are available.
    std::env::set_var("ENCDR_FORCE_SERVICE", "1");
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(io::stderr)
        .init();
    let mut args = std::env::args().skip(1);
    let controller = args.next().unwrap_or_else(|| "auto".into());
    let visible = args.any(|arg| arg == "--visible");
    let product = match controller.as_str() {
        "auto" => None,
        "maschine-studio" => Some(0x1300),
        "kontrol-s5" => Some(0x1420),
        "kontrol-s8" => Some(0x1370),
        name => Some(
            Profile::for_name(name)
                .ok_or_else(|| format!("Unknown controller: {name}"))?
                .product,
        ),
    };

    let mut encdr = Encdr::new(EncdrConfig {
        auto_hotplug: true,
        supported_controllers: Some(ControllerFilter::custom(move |descriptor| {
            product.is_none_or(|id| id == descriptor.product_id.0) && supports_displays(descriptor)
        })),
        ..Default::default()
    })?;
    let mut preview = None;
    let mut preview_device = None;
    let (sender, updates) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(payload) = serde_json::from_str::<Value>(&line) {
                if sender.send(payload).is_err() {
                    break;
                }
            }
        }
    });

    let events = encdr.events().clone();
    let mut surfaces = HashMap::<DeviceId, Surface>::new();
    let mut state = Value::Null;
    let mut track_activity = 0;
    let mut active_page = 0;
    let mut active_slot = None;
    eprintln!("Waiting for compatible NI controllers ({controller})");

    run_event_loop_with_target(|target| {
        if visible && preview.is_none() {
            let result = PreviewWindow::new(target, SCREEN_SIZE).and_then(|window| {
                Displays::new(true, |side, content| {
                    ScreenView::new_preview(&window, side, SCREEN_SIZE, content)
                })
            });
            match result {
                Ok(displays) => preview = Some(displays),
                Err(error) => {
                    eprintln!("Could not create preview displays: {error}");
                    return false;
                }
            }
        }
        let connected = encdr.connected_devices();
        let mut running = true;
        surfaces.retain(|id, surface| {
            if connected.contains(id) {
                return true;
            }
            if surface.owned {
                running &= send_device_input(*id, json!({ "kind": "ownership", "active": false }));
            }
            eprintln!("{id} disconnected");
            false
        });
        for id in connected {
            let surface = surfaces.entry(id).or_default();
            let owned = encdr.has_control(id);
            if owned == surface.owned {
                continue;
            }
            eprintln!("{id} owns displays={owned}");
            surface.owned = owned;
            surface.controls = Controls::default();
            surface.update(&state, &state);
            surface.knob_remainders.fill(0.0);
            surface.lamps.clear();
            surface.dirty = true;
            if owned && surface.displays.is_none() {
                match Displays::new(false, |side, content| {
                    ScreenView::new_on_target(target, id, side, SCREEN_SIZE, content, false)
                }) {
                    Ok(displays) => surface.displays = Some(displays),
                    Err(error) => eprintln!("{id}: could not create displays: {error}"),
                }
            }
            if surface.displays.is_some() {
                running &= send_device_input(id, json!({ "kind": "ownership", "active": owned }));
            }
        }
        if !running {
            return false;
        }
        while let Ok(event) = events.try_recv() {
            let id = event.device_id();
            if let Some(surface) = surfaces
                .get_mut(&id)
                .filter(|surface| surface.owned && surface.displays.is_some())
            {
                if let Some(profile) = Profile::for_product(id.product_id()) {
                    if let Some(input) = surface.input(profile, event, active_page, active_slot) {
                        if !send_device_input(id, input) {
                            return false;
                        }
                    }
                }
            }
        }

        let mut state_changed = false;
        loop {
            match updates.try_recv() {
                Ok(payload) => {
                    if payload["type"] == "track_activity" {
                        track_activity = payload["mask"].as_u64().unwrap_or(0) as u8;
                        if !state.is_null() {
                            for (&id, surface) in
                                surfaces.iter_mut().filter(|(_, surface)| surface.owned)
                            {
                                if let Some(profile) = Profile::for_product(id.product_id()) {
                                    surface.update_lamps(
                                        &encdr,
                                        id,
                                        profile,
                                        &state,
                                        track_activity,
                                    );
                                }
                            }
                        }
                        continue;
                    }
                    state_changed |= payload != state;
                    for surface in surfaces.values_mut().filter(|surface| surface.owned) {
                        surface.update(&state, &payload);
                    }
                    active_page = payload["page"].as_u64().unwrap_or(0);
                    active_slot = payload["slots"]
                        .as_array()
                        .and_then(|slots| {
                            slots
                                .iter()
                                .position(|slot| slot["page"].as_u64() == Some(active_page))
                        })
                        .map(|index| index + 1);
                    state = payload;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return false,
            }
        }
        if let Some(displays) = &preview {
            if !preview_device.is_some_and(|id| {
                surfaces
                    .get(&id)
                    .is_some_and(|surface| surface.owned && surface.displays.is_some())
            }) {
                let previous_device = preview_device;
                preview_device = surfaces
                    .iter()
                    .find(|(_, surface)| surface.owned && surface.displays.is_some())
                    .map(|(&id, _)| id);
                if let Some(surface) = preview_device.and_then(|id| surfaces.get_mut(&id)) {
                    surface.dirty = true;
                } else if (state_changed || previous_device.is_some()) && !state.is_null() {
                    send_track_view(displays, &state);
                }
            }
            displays.poll(&encdr);
        }
        for (&id, surface) in surfaces.iter_mut().filter(|(_, surface)| surface.owned) {
            let mirrored = preview.as_ref().filter(|_| preview_device == Some(id));
            surface.render(
                &encdr,
                id,
                &state,
                active_page,
                active_slot,
                track_activity,
                mirrored,
            );
        }
        true
    });
    encdr.clean_exit();
    Ok(())
}
