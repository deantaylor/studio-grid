mod controls;

use controls::{Controls, Profile, DISPLAY_BUTTONS};
use encdr::{DeviceId, Encdr, EncdrConfig, Event, LedValue};
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

fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(io::stderr)
        .init();
    let mut args = std::env::args().skip(1);
    let controller = args.next().unwrap_or_else(|| "s49".into());
    let visible = args.any(|arg| arg == "--visible");
    let profile = Profile::for_name(&controller)
        .ok_or_else(|| format!("Unknown controller: {controller}"))?;
    let product = profile.product;

    let mut encdr = Encdr::new(EncdrConfig {
        auto_hotplug: true,
        supported_controllers: Some((0x17cc, product).into()),
        ..Default::default()
    })?;
    let make_screen = |side: &str| {
        ScreenView::new_unbound(
            side,
            (480, 272),
            ScreenContent::Html(PANEL.replace("__SIDE__", side)),
            visible,
        )
    };
    let mut left = make_screen("left")?;
    let mut right = make_screen("right")?;

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
    let mut device: Option<DeviceId> = None;
    let mut owns_device = false;
    let mut controls = Controls::default();
    let mut lamps = HashMap::new();
    let mut knob_remainders = [0.0; 8];
    let mut state = Value::Null;
    let mut display_lamps = [LedValue::Off; 8];
    let mut dirty = false;
    eprintln!("Waiting for {controller} (17cc:{product:04x})");

    ScreenView::run_event_loop(|| {
        let connected = device.filter(|id| encdr.is_connected(*id)).or_else(|| {
            encdr
                .connected_devices()
                .into_iter()
                .filter(|id| id.vendor_id() == 0x17cc && id.product_id() == product)
                .min_by_key(|id| id.to_string())
        });
        let owned = connected.is_some_and(|id| encdr.has_control(id));
        if connected != device || owned != owns_device {
            if owned != owns_device && !send_input(json!({ "kind": "ownership", "active": owned }))
            {
                return false;
            }
            controls = Controls::default();
            controls.launcher_active = state["patternLauncherActive"] == true;
            lamps.clear();
            knob_remainders.fill(0.0);
            device = connected;
            owns_device = owned;
            if let Some(id) = connected.filter(|_| owned) {
                left.set_device_id(id);
                right.set_device_id(id);
                dirty = true;
            }
            eprintln!(
                "{controller} connected={}, owns displays={owned}",
                connected.is_some()
            );
        }
        while let Ok(event) = events.try_recv() {
            if !owns_device || Some(event.device_id()) != device {
                continue;
            }
            let input = match event {
                Event::Button { name, pressed, .. }
                    if profile.buttons().any(|button| button == name)
                        || profile.dial_button(name).is_some() =>
                {
                    dirty = true;
                    let Some(action) = controls.button(profile, name, pressed) else {
                        continue;
                    };
                    action
                }
                Event::Encoder { name, delta, .. }
                    if !controls.launcher_active && name == profile.dial && delta != 0 =>
                {
                    json!({ "kind": "dial", "dial": delta })
                }
                Event::EncoderFine { name, delta, .. }
                    if !controls.launcher_active && delta.is_finite() =>
                {
                    let Some(knob) = slot(name, profile.knob_prefix) else {
                        continue;
                    };
                    let remainder = &mut knob_remainders[knob - 1];
                    let resolution = if knob <= 2 { 0.01 } else { 0.04 };
                    *remainder += f64::from(delta);
                    let steps = (*remainder / resolution).trunc() as i32;
                    if steps == 0 {
                        continue;
                    }
                    *remainder -= f64::from(steps) * resolution;
                    json!({ "kind": "knob", "knob": knob, "steps": steps.clamp(-64, 64) })
                }
                _ => continue,
            };
            if !send_input(input) {
                return false;
            }
        }
        loop {
            match updates.try_recv() {
                Ok(payload) => {
                    dirty |= payload != state;
                    let launcher_active = payload["patternLauncherActive"] == true;
                    if payload["page"] != state["page"]
                        || payload["parameters"][4]["value"] != state["parameters"][4]["value"]
                        || launcher_active != controls.launcher_active
                    {
                        controls.clear_confirm = false;
                    }
                    controls.launcher_active = launcher_active;
                    state = payload;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return false,
            }
        }
        if (owns_device || visible) && dirty && !state.is_null() {
            let colors = controls.display_button_colors(profile, &state);
            display_lamps = std::array::from_fn(|index| {
                controls.display_lamp(profile, DISPLAY_BUTTONS[index], colors[index])
            });
            let mut view = state.clone();
            view["selector"] = json!(controls.mode(profile));
            view["buttonColors"] = json!(colors);
            view["clearHeld"] = json!(controls.clear_held(profile));
            view["clearConfirm"] = json!(controls.clear_confirm);
            left.send("state", view.clone());
            right.send("state", view);
            dirty = false;
        }
        if let Some(id) = device.filter(|_| owns_device) {
            for name in profile.lamp_buttons() {
                let value = if let Some(index) =
                    DISPLAY_BUTTONS.iter().position(|button| *button == name)
                {
                    display_lamps[index]
                } else if profile.launcher == Some(name) && controls.launcher_active {
                    profile.lamp(name, true)
                } else {
                    controls.lamp(profile, name)
                };
                if lamps.insert(name, value) != Some(value) {
                    encdr.set_led(id, name, value);
                }
            }
            left.poll(&encdr);
            right.poll(&encdr);
        }
        true
    });
    encdr.clean_exit();
    Ok(())
}
