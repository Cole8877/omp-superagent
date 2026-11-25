// allow: SIZE_OK — Each picker transition and its admission binding are evaluated atomically.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{adapter::EffectError, store::now};

mod view;
#[cfg(test)]
mod tests;

pub(crate) const PREFIX: &str = "sgp:";
pub(crate) const EXPIRED: &str = "This menu is unavailable. Run the original command again.";
pub(crate) const ACCEPTED: &str = "Selection accepted. The HEAD result will appear in this conversation.";
pub(crate) const CANCELLED: &str = "Selection cancelled. Nothing was changed.";
// A page fits Telegram's button layout and one native dropdown on either other platform.
const PAGE: usize = 8;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    Model,
    Effort,
    UsageReset,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Picker {
    kind: Kind,
    expires_at: i64,
    current: Option<String>,
    current_provider: Option<String>,
    groups: Vec<Group>,
    #[serde(default, deserialize_with = "present")]
    model_targets: Option<ModelTargets>,
}

// The controller owns the saved lane generation/session checks. The Gateway
// displays the lane from that same card and returns only the selected target.
#[derive(Clone, Deserialize)]
struct ModelTargets {
    #[serde(default, deserialize_with = "present")]
    lane: Option<ModelLane>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelLane {
    id: String,
    current: Option<String>,
    current_provider: Option<String>,
    #[serde(default, deserialize_with = "present")]
    allowed_options: Option<Vec<Vec<usize>>>,
}

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    // An omitted field is allowed; an explicit null is not a target spec.
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Deserialize)]
struct Group {
    label: String,
    options: Vec<String>,
}

pub(crate) struct Menu {
    pub text: String,
    pub select_id: String,
    pub options: Vec<Item>,
    pub buttons: Vec<Item>,
    pub target_select: Option<TargetSelect>,
    pub select_disabled: bool,
}

pub(crate) struct TargetSelect {
    pub control: String,
    pub lane_label: Option<String>,
    pub selected: Option<ModelTarget>,
}

pub(crate) struct Item {
    pub label: String,
    pub control: String,
    pub value: String,
}

pub(crate) enum Change {
    Show(Navigation),
    Cancel,
    Select(Selection),
}

pub(crate) struct Navigation {
    token: Uuid,
    next: Screen,
    pub menu: Menu,
}

#[derive(Clone)]
pub(crate) struct Selection {
    token: Uuid,
    pub event: Value,
    pub target: Option<ModelTarget>,
}

pub(crate) struct Opening {
    pub menu: Menu,
    entry: Entry,
}

struct Entry {
    token: Uuid,
    output_id: String,
    route: Value,
    text: String,
    picker: Picker,
    screen: Screen,
}

#[derive(Clone, Copy)]
struct Screen {
    stage: Stage,
    revision: u32,
    scope: ModelScope,
}

#[derive(Clone, Copy)]
enum Stage {
    Browse { group: Option<usize>, page: usize },
    ConfirmUsageReset { option: usize },
}

#[derive(Clone, Copy)]
enum ModelScope {
    Unscoped,
    AwaitingTarget,
    Selected(ModelTarget),
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ModelTarget {
    Head,
    Lane,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Pick(usize),
    Target(ModelTarget),
    Previous,
    Next,
    Back,
    Cancel,
    Confirm,
}

struct Card {
    entry: Entry,
    message_id: String,
    navigating: bool,
    selection: Option<(Action, Selection)>,
}

#[derive(Clone, Default)]
pub(crate) struct Pickers {
    cards: Arc<Mutex<HashMap<Uuid, Card>>>,
    delivery: Arc<tokio::sync::Mutex<()>>,
}

impl Pickers {
    /// A callback can reach the socket before the HTTP send returns the card ID.
    pub(crate) async fn delivery(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.delivery.lock().await
    }

    pub(crate) fn open(
        &self,
        id: &str,
        route: Value,
        text: &str,
        spec: &Picker,
    ) -> Result<Option<Opening>, EffectError> {
        if spec.expires_at <= time()?
            || spec.groups.is_empty()
            || (spec.kind == Kind::UsageReset && spec.groups.len() != 1)
        {
            return Ok(None);
        }
        let scope = match (spec.kind, route["platform"].as_str(), &spec.model_targets) {
            (Kind::Model, Some("discord"), Some(targets)) if targets.lane.is_some() => {
                ModelScope::AwaitingTarget
            }
            (Kind::Model, Some("discord"), Some(_)) => ModelScope::Selected(ModelTarget::Head),
            _ => ModelScope::Unscoped,
        };
        let entry = Entry {
            token: Uuid::new_v4(),
            output_id: id.to_owned(),
            route,
            text: text.to_owned(),
            picker: spec.clone(),
            screen: Screen {
                stage: Stage::Browse {
                    group: match spec.kind {
                        Kind::Model => None,
                        Kind::Effort | Kind::UsageReset => Some(0),
                    },
                    page: 0,
                },
                revision: 0,
                scope,
            },
        };
        Ok(entry.view(entry.screen).map(|menu| Opening { menu, entry }))
    }

    pub(crate) fn posted(&self, opening: Opening, message_id: String) -> Result<(), EffectError> {
        let entry = opening.entry;
        let current = time()?;
        let mut cards = self.cards.lock().map_err(|_| ledger_error())?;
        cards.retain(|_, card| {
            let old = &card.entry;
            card.selection.is_some()
                || old.picker.expires_at > current
                    && (old.picker.kind != entry.picker.kind || old.route != entry.route)
        });
        if entry.picker.expires_at > current {
            cards.insert(entry.token, Card { entry, message_id, navigating: false, selection: None });
        }
        Ok(())
    }

    /// The adapter supplies authenticated message linkage; only this registry
    /// translates actions and options advertised on the current page.
    pub(crate) fn choose(
        &self,
        control: &str,
        value: Option<&str>,
        matches: impl FnOnce(&Value, &str) -> bool,
    ) -> Result<Option<Change>, EffectError> {
        let Some((token, revision, action)) = parse(control, value) else {
            return Ok(None);
        };
        let current = time()?;
        let mut cards = self.cards.lock().map_err(|_| ledger_error())?;
        // Expiry denies new choices, not replay of the exact already-frozen
        // event. Only HEAD decides whether a late admission may still apply.
        cards.retain(|_, card| card.selection.is_some() || card.entry.picker.expires_at > current);
        let Some(card) = cards.get_mut(&token) else {
            return Ok(None);
        };
        let entry = &card.entry;
        if card.navigating || revision != entry.screen.revision || !matches(&entry.route, &card.message_id) {
            return Ok(None);
        }
        if !matches!(entry.screen.scope, ModelScope::Unscoped)
            && matches!(action, Action::Pick(_))
            && value.is_none()
        {
            // Scoped cards never advertise the numeric button IDs used by Telegram.
            return Ok(None);
        }
        if let Some((original, selection)) = &card.selection {
            // Only the exact same durable event may be retried after an
            // unconfirmed SQLite write. A second choice cannot replace it.
            return Ok((action == *original).then(|| Change::Select(selection.clone())));
        }
        if action == Action::Cancel {
            cards.remove(&token);
            return Ok(Some(Change::Cancel));
        }
        let mut scope = entry.screen.scope;
        let stage = match (entry.screen.stage, action) {
            (stage, Action::Target(target)) => {
                let has_lane = entry.picker.model_targets.as_ref().is_some_and(|targets| targets.lane.is_some());
                if matches!(scope, ModelScope::Unscoped) || target == ModelTarget::Lane && !has_lane {
                    return Ok(None);
                }
                let next_scope = ModelScope::Selected(target);
                let catalogue_changed =
                    entry.lane_options(scope).is_some() != entry.lane_options(next_scope).is_some();
                scope = next_scope;
                if catalogue_changed {
                    Stage::Browse { group: None, page: 0 }
                } else {
                    stage
                }
            }
            (Stage::Browse { group, page }, action) => {
                let Some(indices) = entry.indices(scope, group) else {
                    return Ok(None);
                };
                match action {
                    Action::Previous if page > 0 => Stage::Browse { group, page: page - 1 },
                    Action::Next => {
                        if page >= indices.count().div_ceil(PAGE).saturating_sub(1) {
                            return Ok(None);
                        }
                        Stage::Browse { group, page: page + 1 }
                    }
                    Action::Back if entry.picker.kind == Kind::Model && group.is_some() => {
                        let Some(rank) = entry.indices(scope, None).and_then(|mut providers| {
                            providers.position(|index| Some(index) == group)
                        }) else {
                            return Ok(None);
                        };
                        Stage::Browse { group: None, page: rank / PAGE }
                    }
                    Action::Pick(index) => {
                        if !indices
                            .skip(page.saturating_mul(PAGE))
                            .take(PAGE)
                            .any(|shown| shown == index)
                        {
                            return Ok(None);
                        }
                        match (entry.picker.kind, group) {
                            (Kind::UsageReset, Some(0)) => Stage::ConfirmUsageReset { option: index },
                            (Kind::Model | Kind::Effort, Some(group)) => {
                                let target = match scope {
                                    ModelScope::Unscoped => None,
                                    ModelScope::AwaitingTarget => return Ok(None),
                                    ModelScope::Selected(target) => Some(target),
                                };
                                return Ok(Some(card.select(action, group, index, current, target)));
                            }
                            (Kind::Model, None) => Stage::Browse { group: Some(index), page: 0 },
                            (Kind::UsageReset, _) | (Kind::Effort, None) => return Ok(None),
                        }
                    }
                    Action::Previous
                    | Action::Back
                    | Action::Target(_)
                    | Action::Confirm
                    | Action::Cancel => return Ok(None),
                }
            }
            (Stage::ConfirmUsageReset { option }, action) => match action {
                Action::Back => Stage::Browse { group: Some(0), page: option / PAGE },
                Action::Confirm => return Ok(Some(card.select(action, 0, option, current, None))),
                Action::Previous | Action::Next | Action::Pick(_) | Action::Target(_) | Action::Cancel => {
                    return Ok(None);
                }
            },
        };
        let Some(revision) = revision.checked_add(1) else {
            return Ok(None);
        };
        let next = Screen { stage, revision, scope };
        Ok(entry.view(next).map(|menu| {
            card.navigating = true;
            Change::Show(Navigation { token, next, menu })
        }))
    }

    pub(crate) fn admitted(&self, selection: &Selection) -> Result<(), EffectError> {
        self.cards.lock().map_err(|_| ledger_error())?.remove(&selection.token);
        Ok(())
    }

    pub(crate) fn navigated(
        &self, navigation: &Navigation, result: &Result<(), EffectError>,
    ) -> Result<(), EffectError> {
        let mut cards = self.cards.lock().map_err(|_| ledger_error())?;
        let Some(card) = cards.get_mut(&navigation.token) else { return Ok(()); };
        card.navigating = false;
        match result {
            Ok(()) => card.entry.screen = navigation.next,
            // Keep the controls from the still-displayed page.
            Err(error) if error.certainty == "rejected" => (),
            // An ambiguous edit doesn't authorize either visible revision.
            Err(_) => { cards.remove(&navigation.token); }
        }
        Ok(())
    }
}

impl Card {
    fn select(
        &mut self,
        action: Action,
        group: usize,
        option: usize,
        current: i64,
        target: Option<ModelTarget>,
    ) -> Change {
        let entry = &self.entry;
        let mut selected = json!({
            "outputId": entry.output_id, "cardId": self.message_id,
            "group": group, "option": option
        });
        if action == Action::Confirm {
            selected["confirmed"] = json!(true);
        }
        if let Some(target) = target {
            selected["target"] = json!(target);
        }
        let event = json!({"kind": "message", "input": {
            "id": format!("picker:{}", entry.output_id),
            "route": entry.route,
            "messageId": null,
            "receivedAt": current,
            "attachments": [],
            "text": "",
            "pickerSelection": selected
        }});
        let selection = Selection { token: entry.token, event, target };
        self.selection = Some((action, selection.clone()));
        Change::Select(selection)
    }
}

impl Entry {
    fn lane_options(&self, scope: ModelScope) -> Option<&[Vec<usize>]> {
        match scope {
            ModelScope::Selected(ModelTarget::Lane) => self
                .picker
                .model_targets
                .as_ref()?
                .lane
                .as_ref()?
                .allowed_options
                .as_deref(),
            ModelScope::Unscoped
            | ModelScope::AwaitingTarget
            | ModelScope::Selected(ModelTarget::Head) => None,
        }
    }

    // Pagination counts visible entries, but a choice always uses the original
    // HEAD catalogue coordinates, including gaps left by the lane filter.
    fn indices(
        &self,
        scope: ModelScope,
        group: Option<usize>,
    ) -> Option<impl Iterator<Item = usize> + Clone + '_> {
        let end = match group {
            Some(group) => self.picker.groups.get(group)?.options.len(),
            None => self.picker.groups.len(),
        };
        let lane_options = self.lane_options(scope);
        Some((0..end).filter(move |&index| {
            let Some(lane_options) = lane_options else {
                return true;
            };
            match group {
                Some(group) => lane_options
                    .get(group)
                    .is_some_and(|options| options.contains(&index)),
                None => lane_options
                    .get(index)
                    .zip(self.picker.groups.get(index))
                    .is_some_and(|(allowed, group)| {
                        allowed.iter().any(|&option| option < group.options.len())
                    }),
            }
        }))
    }
}

fn parse(control: &str, value: Option<&str>) -> Option<(Uuid, u32, Action)> {
    let (id, rest) = control.strip_prefix(PREFIX)?.split_once(':')?;
    let (revision, action) = rest.split_once(':')?;
    let token = Uuid::try_parse(id).ok()?;
    let action = match (action, value) {
        ("s", Some(index)) => Action::Pick(number(index)?),
        ("t", Some("head")) => Action::Target(ModelTarget::Head),
        ("t", Some("lane")) => Action::Target(ModelTarget::Lane),
        ("s", None) | (_, Some(_)) => return None,
        ("p", None) => Action::Previous,
        ("n", None) => Action::Next,
        ("b", None) => Action::Back,
        ("x", None) => Action::Cancel,
        ("c", None) => Action::Confirm,
        (index, None) => Action::Pick(number(index)?),
    };
    Some((token, number(revision)?, action))
}

fn number<T: std::str::FromStr>(text: &str) -> Option<T> {
    if text.is_empty() || (text.len() > 1 && text.starts_with('0')) || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn time() -> Result<i64, EffectError> {
    now().map_err(|_| ledger_error())
}

fn ledger_error() -> EffectError {
    EffectError::uncertain("Selection card state could not be verified")
}
