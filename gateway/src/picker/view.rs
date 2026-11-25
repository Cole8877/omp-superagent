use super::{Entry, Item, Kind, Menu, ModelScope, ModelTarget, PAGE, PREFIX, Screen, Stage, TargetSelect};

const LABEL_LIMIT: usize = 68; // Slack plain_text has a 75-character limit.
const TEXT_LIMIT: usize = 2_000; // Discord component-message content limit.

impl Entry {
    pub(super) fn view(&self, screen: Screen) -> Option<Menu> {
        let control =
            |action: &str| format!("{PREFIX}{}:{}:{action}", self.token.simple(), screen.revision);
        let button = |action: &str, label: &str| Item {
            label: label.to_owned(),
            control: control(action),
            value: action.to_owned(),
        };
        let (group, page) = match screen.stage {
            Stage::Browse { group, page } => (group, page),
            Stage::ConfirmUsageReset { option } => {
                let label = self.picker.groups.first()?.options.get(option)?;
                let footer = format!("\n\nUse one currently available OMP usage reset credit for:\n{label}");
                return Some(Menu {
                    text: self.with_footer(&footer)?,
                    select_id: control("s"),
                    options: Vec::new(),
                    buttons: vec![
                        button("c", "Confirm"),
                        button("b", "Back"),
                        button("x", "Cancel"),
                    ],
                    target_select: None,
                    select_disabled: false,
                });
            }
        };
        let indices = self.indices(screen.scope, group)?;
        let count = indices.clone().count();
        if count == 0 && self.lane_options(screen.scope).is_none() {
            return None;
        }
        let group = group.and_then(|index| self.picker.groups.get(index));
        let lane = self.picker.model_targets.as_ref().and_then(|targets| targets.lane.as_ref());
        let target_select = match screen.scope {
            ModelScope::Unscoped => None,
            ModelScope::AwaitingTarget | ModelScope::Selected(_) => Some(TargetSelect {
                control: control("t"),
                lane_label: lane.map(|lane| shorten(&format!("Lane: {}", lane.id), LABEL_LIMIT)),
                selected: match screen.scope {
                    ModelScope::Selected(target) => Some(target),
                    ModelScope::Unscoped | ModelScope::AwaitingTarget => None,
                },
            }),
        };
        let (current, current_provider) = match screen.scope {
            ModelScope::Unscoped | ModelScope::Selected(ModelTarget::Head) => {
                (self.picker.current.as_ref(), self.picker.current_provider.as_deref())
            }
            ModelScope::AwaitingTarget => (None, None),
            ModelScope::Selected(ModelTarget::Lane) => {
                let lane = lane?;
                (lane.current.as_ref(), lane.current_provider.as_deref())
            }
        };
        let title = match (self.picker.kind, group) {
            (Kind::Effort, _) => "Choose thinking effort".to_owned(),
            (Kind::UsageReset, _) => "Choose an account for a usage reset".to_owned(),
            (Kind::Model, Some(group)) => {
                format!("Choose a model from {}", shorten(&group.label, LABEL_LIMIT))
            }
            (Kind::Model, None) => "Choose a model provider".to_owned(),
        };
        let mut options = Vec::with_capacity(PAGE);
        for index in indices.skip(page.saturating_mul(PAGE)).take(PAGE) {
            let (label, is_current) = match group {
                Some(group) => {
                    let label = group.options.get(index)?;
                    (label, current == Some(label) && current_provider.is_none_or(|p| p == group.label))
                }
                None => {
                    let provider = self.picker.groups.get(index)?;
                    (
                        &provider.label,
                        current_provider.map_or_else(
                            || current.is_some_and(|model| provider.options.contains(model)),
                            |name| name == provider.label,
                        ),
                    )
                }
            };
            let label = shorten(label, LABEL_LIMIT);
            let value = index.to_string();
            options.push(Item {
                label: if is_current { format!("✓ {label}") } else { label },
                control: control(&value),
                value,
            });
        }
        let pages = count.div_ceil(PAGE);
        let mut buttons = Vec::new();
        if page > 0 {
            buttons.push(button("p", "Previous"));
        }
        if page < pages.saturating_sub(1) {
            buttons.push(button("n", "Next"));
        }
        if self.picker.kind == Kind::Model && group.is_some() {
            buttons.push(button("b", "Back"));
        }
        buttons.push(button("x", "Cancel"));
        let mut footer = if count == 0 {
            "\n\nNo compatible models are available for this lane. Select HEAD to browse its catalogue.".to_owned()
        } else {
            format!("\n\n{title} · page {}/{pages}", page + 1)
        };
        if let Some(target) = &target_select {
            let label = match target.selected {
                Some(ModelTarget::Head) => "HEAD",
                Some(ModelTarget::Lane) => target.lane_label.as_deref()?,
                None => "Choose HEAD or the bound lane before selecting a model",
            };
            footer.push_str("\nDestination: ");
            footer.push_str(label);
        }
        Some(Menu {
            text: self.with_footer(&footer)?,
            select_id: control("s"),
            options,
            buttons,
            target_select,
            select_disabled: group.is_some() && matches!(screen.scope, ModelScope::AwaitingTarget),
        })
    }

    fn with_footer(&self, footer: &str) -> Option<String> {
        let remaining = TEXT_LIMIT.checked_sub(footer.encode_utf16().count())?;
        if remaining == 0 {
            return Some(footer.to_owned());
        }
        let status = shorten(&self.text, remaining);
        Some(format!("{status}{footer}"))
    }
}

fn shorten(label: &str, limit: usize) -> String {
    if label.encode_utf16().count() <= limit {
        return label.to_owned();
    }
    let (front, back) = (limit.saturating_sub(1) / 2, limit / 2);
    let head = label
        .chars()
        .scan(front, |space, ch| {
            *space = space.checked_sub(ch.len_utf16())?;
            Some(ch)
        })
        .collect::<String>();
    let tail = label
        .chars()
        .rev()
        .scan(back, |space, ch| {
            *space = space.checked_sub(ch.len_utf16())?;
            Some(ch)
        })
        .collect::<Vec<_>>();
    head.chars().chain(['…']).chain(tail.into_iter().rev()).collect()
}
