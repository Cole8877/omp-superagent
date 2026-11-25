use super::*;

fn thread_interaction(id: &str, kind: u8, data: Value) -> Value {
    json!({"application_id":"72","guild_id":"77","member":{"user":{"id":"42"}},
        "channel":{"id":"90"},"token":"offline-interaction","type":kind,"id":id,"data":data})
}

async fn model_route(
    socket: &mut FixtureSocket,
    observed: &mut mpsc::UnboundedReceiver<(String, Value)>,
    hub: &Hub,
    store: &Store,
) -> Value {
    let slash = thread_interaction("3", 2, json!({"type":1,"name":"model"}));
    dispatch(socket, 3, "INTERACTION_CREATE", slash).await;
    let ack = received(observed, "/interactions/3/offline-interaction/callback").await;
    assert_eq!(ack["type"], 4);
    let input = &event(hub, store).await["input"];
    assert_eq!(input["text"], "/model");
    assert_eq!(input["route"], json!({"platform":"discord","accountId":"71","authorityId":"42",
        "guildId":"77","channelId":"88","threadId":"90"}));
    input["route"].clone()
}

async fn open_model_card(
    hub: &Hub,
    observed: &mut mpsc::UnboundedReceiver<(String, Value)>,
    route: &Value,
    id: &str,
    targets: Value,
) -> Value {
    let models = (0..10).map(|index| format!("local/model-{index}")).collect::<Vec<_>>();
    let output = json!({"id":id,"route":route,"text":"HEAD: local/model-0",
        "picker":{"kind":"model","current":"local/model-0","currentProvider":"local",
            "expiresAt":crate::store::now().unwrap()+300_000,"modelTargets":targets,
            "groups":[{"label":"other","options":["other/model"]},{"label":"local","options":models}]}});
    let id = hub.effect("send", &[output]).await.unwrap();
    assert_eq!(id, "701");
    let posted = received(observed, "/channels/90/messages").await;
    json!({"id":id,"guild_id":"77","channel_id":"90","author":{"id":"71","bot":true},
        "components":posted["components"]})
}

async fn click(
    socket: &mut FixtureSocket,
    observed: &mut mpsc::UnboundedReceiver<(String, Value)>,
    sequence: u64,
    source: &Value,
    control: &Value,
    value: Option<&Value>,
) -> Value {
    let id = sequence.to_string();
    let mut data = json!({"custom_id":control["custom_id"],"component_type":control["type"]});
    if let Some(value) = value {
        data["values"] = json!([value]);
    }
    let mut callback = thread_interaction(&id, 3, data);
    callback["message"] = source.clone();
    dispatch(socket, sequence, "INTERACTION_CREATE", callback).await;
    received(observed, &format!("/interactions/{id}/offline-interaction/callback")).await
}

fn select(card: &Value, row: usize) -> &Value {
    let row = &card["components"][row];
    assert_eq!(row["type"], 1);
    assert_eq!(row["components"].as_array().unwrap().len(), 1);
    let select = &row["components"][0];
    assert_eq!(select["type"], 3);
    select
}

fn button<'a>(card: &'a Value, label: &str) -> &'a Value {
    card["components"][2]["components"].as_array().unwrap().iter()
        .find(|button| button["type"] == 2 && button["label"] == label)
        .unwrap_or_else(|| panic!("missing {label} button"))
}

fn updated(card: &Value, reply: &Value, store: &Store) -> Value {
    assert_eq!(reply["type"], 7, "navigation must edit the original card");
    assert_eq!(reply["data"]["components"].as_array().unwrap().len(), 3);
    assert_eq!(store.pending().unwrap(), 0, "navigation must not admit a model change");
    let mut updated = card.clone();
    updated["components"] = reply["data"]["components"].clone();
    updated
}

fn refused(reply: &Value, store: &Store) {
    assert_eq!(reply["type"], 4);
    assert_eq!(reply["data"]["flags"], 64);
    assert_eq!(store.pending().unwrap(), 0, "refused controls must not admit a change");
}

#[tokio::test]
async fn scoped_model_card_browses_and_admits_only_the_current_target_and_page() {
    let (_temporary, store, hub, ws, mut observed, _, server) =
        discord_fixture(json!({"discord":{}})).await;
    let mut socket = addressing_tests::start(&hub, &ws, false).await;
    let route = model_route(&mut socket, &mut observed, &hub, &store).await;
    let initial = open_model_card(&hub, &mut observed, &route, "lane-model-card", json!({
        "lane":{"id":"lane-browser","generation":3,"sessionId":"lane-native",
            "current":"local/model-8","currentProvider":"local"}
    })).await;
    let target = select(&initial, 0);
    let providers = select(&initial, 1);
    assert_eq!(target["options"], json!([
        {"label":"HEAD","value":"head","default":false},
        {"label":"Lane: lane-browser","value":"lane","default":false}
    ]));
    assert_eq!(providers["options"], json!([
        {"label":"other","value":"0"},{"label":"local","value":"1"}
    ]));

    let reply = click(&mut socket, &mut observed, 4, &initial, providers, Some(&providers["options"][1]["value"])).await;
    let pending = updated(&initial, &reply, &store);
    let models = select(&pending, 1);
    assert_eq!(models["disabled"], true, "the model list is browsable but cannot commit implicitly");
    let reply = click(&mut socket, &mut observed, 5, &pending, models, Some(&models["options"][0]["value"])).await;
    refused(&reply, &store);
    let reply = click(&mut socket, &mut observed, 6, &initial, target, Some(&target["options"][1]["value"])).await;
    refused(&reply, &store);

    let target = select(&pending, 0);
    let reply = click(&mut socket, &mut observed, 7, &pending, target, Some(&target["options"][0]["value"])).await;
    let head_models = updated(&pending, &reply, &store);
    assert_eq!(select(&head_models, 0)["options"][0]["default"], true);
    assert_ne!(select(&head_models, 1)["disabled"], true);
    assert_eq!(select(&head_models, 1)["options"][0]["label"], "✓ local/model-0");
    let reply = click(&mut socket, &mut observed, 8, &head_models, button(&head_models, "Back"), None).await;
    let head_providers = updated(&head_models, &reply, &store);
    let providers = select(&head_providers, 1);
    assert_eq!(providers["options"][1]["label"], "✓ local");
    let reply = click(&mut socket, &mut observed, 9, &head_providers, providers, Some(&providers["options"][1]["value"])).await;
    let first_page = updated(&head_providers, &reply, &store);
    let reply = click(&mut socket, &mut observed, 10, &first_page, button(&first_page, "Next"), None).await;
    let head_page = updated(&first_page, &reply, &store);
    let head_select = select(&head_page, 1);
    assert_eq!(head_select["options"][0]["label"], "local/model-8");

    let target = select(&head_page, 0);
    let reply = click(&mut socket, &mut observed, 11, &head_page, target, Some(&target["options"][1]["value"])).await;
    let lane_page = updated(&head_page, &reply, &store);
    assert_eq!(select(&lane_page, 0)["options"][0]["default"], false);
    assert_eq!(select(&lane_page, 0)["options"][1]["default"], true);
    assert_eq!(select(&lane_page, 1)["options"], json!([
        {"label":"✓ local/model-8","value":"8"},{"label":"local/model-9","value":"9"}
    ]));
    let reply = click(&mut socket, &mut observed, 12, &head_page, head_select, Some(&head_select["options"][1]["value"])).await;
    refused(&reply, &store);

    let lane_select = select(&lane_page, 1);
    let value = &lane_select["options"][1]["value"];
    let reply = click(&mut socket, &mut observed, 13, &lane_page, lane_select, Some(value)).await;
    assert_eq!(reply["type"], 7);
    assert_eq!(reply["data"]["components"], json!([]));
    assert!(!reply["data"]["content"].as_str().unwrap().contains("HEAD"));
    let picked = event(&hub, &store).await;
    assert_eq!(picked["kind"], "message");
    assert_eq!(picked["input"]["route"], route);
    assert_eq!(picked["input"]["messageId"], Value::Null);
    assert_eq!(picked["input"]["pickerSelection"],
        json!({"outputId":"lane-model-card","cardId":"701","group":1,"option":9,"target":"lane"}));
    let reply = click(&mut socket, &mut observed, 14, &lane_page, lane_select, Some(value)).await;
    refused(&reply, &store);

    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn static_review_target_filters_before_paging_without_renumbering_choices() {
    let (_temporary, store, hub, ws, mut observed, _, server) =
        discord_fixture(json!({"discord":{}})).await;
    let mut socket = addressing_tests::start(&hub, &ws, false).await;
    let route = model_route(&mut socket, &mut observed, &hub, &store).await;
    let initial = open_model_card(&hub, &mut observed, &route, "review-card", json!({
        "lane":{"id":"manual-review","generation":3,"sessionId":"review-native",
            "allowedOptions":[[],[0,1,3,4,5,6,7,8,9]]}
    })).await;

    let reply = click(&mut socket, &mut observed, 4, &initial, select(&initial, 0), Some(&json!("lane"))).await;
    let lane_providers = updated(&initial, &reply, &store);
    assert_eq!(select(&lane_providers, 1)["options"], json!([{"label":"local","value":"1"}]));
    let reply = click(&mut socket, &mut observed, 5, &lane_providers, select(&lane_providers, 1), Some(&json!("0"))).await;
    refused(&reply, &store);

    let reply = click(&mut socket, &mut observed, 6, &lane_providers, select(&lane_providers, 1), Some(&json!("1"))).await;
    let lane_first = updated(&lane_providers, &reply, &store);
    let first_options = select(&lane_first, 1)["options"].as_array().unwrap();
    assert_eq!(first_options.iter().map(|item| item["value"].as_str()).collect::<Vec<_>>(),
        ["0", "1", "3", "4", "5", "6", "7", "8"].map(Some));
    let reply = click(&mut socket, &mut observed, 7, &lane_first, select(&lane_first, 1), Some(&json!("2"))).await;
    refused(&reply, &store);
    let reply = click(&mut socket, &mut observed, 8, &lane_first, select(&lane_first, 1), Some(&json!("9"))).await;
    refused(&reply, &store);

    let reply = click(&mut socket, &mut observed, 9, &lane_first, button(&lane_first, "Next"), None).await;
    let lane_last = updated(&lane_first, &reply, &store);
    assert_eq!(select(&lane_last, 1)["options"], json!([{"label":"local/model-9","value":"9"}]));

    let reply = click(&mut socket, &mut observed, 10, &lane_last, select(&lane_last, 0), Some(&json!("head"))).await;
    let head_providers = updated(&lane_last, &reply, &store);
    assert_eq!(select(&head_providers, 1)["options"], json!([
        {"label":"other","value":"0"},{"label":"✓ local","value":"1"}
    ]));
    let reply = click(&mut socket, &mut observed, 11, &head_providers, select(&head_providers, 1), Some(&json!("1"))).await;
    let head_models = updated(&head_providers, &reply, &store);
    let head_select = select(&head_models, 1);
    assert_eq!(head_select["options"][2], json!({"label":"local/model-2","value":"2"}));

    let reply = click(&mut socket, &mut observed, 12, &head_models, select(&head_models, 0), Some(&json!("lane"))).await;
    let lane_providers = updated(&head_models, &reply, &store);
    assert_eq!(select(&lane_providers, 1)["options"], json!([{"label":"local","value":"1"}]));
    let reply = click(&mut socket, &mut observed, 13, &head_models, head_select, Some(&json!("2"))).await;
    refused(&reply, &store);
    let reply = click(&mut socket, &mut observed, 14, &lane_providers, select(&lane_providers, 1), Some(&json!("1"))).await;
    let lane_first = updated(&lane_providers, &reply, &store);
    let reply = click(&mut socket, &mut observed, 15, &lane_first, button(&lane_first, "Next"), None).await;
    let lane_last = updated(&lane_first, &reply, &store);
    let reply = click(&mut socket, &mut observed, 16, &lane_last, select(&lane_last, 1), Some(&json!("9"))).await;
    assert_eq!(reply["type"], 7);
    let picked = event(&hub, &store).await;
    assert_eq!(picked["input"]["pickerSelection"],
        json!({"outputId":"review-card","cardId":"701","group":1,"option":9,"target":"lane"}));

    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn an_empty_worker_catalogue_can_switch_back_to_head_without_admitting_a_choice() {
    let (_temporary, store, hub, ws, mut observed, _, server) =
        discord_fixture(json!({"discord":{}})).await;
    let mut socket = addressing_tests::start(&hub, &ws, false).await;
    let route = model_route(&mut socket, &mut observed, &hub, &store).await;
    let initial = open_model_card(&hub, &mut observed, &route, "worker-model-card", json!({
        "lane":{"id":"remote-worker","generation":0,"sessionId":null,"allowedOptions":[[],[]]}
    })).await;

    let reply = click(&mut socket, &mut observed, 4, &initial, select(&initial, 0), Some(&json!("lane"))).await;
    assert_eq!(reply["type"], 7);
    let mut empty = initial.clone();
    empty["components"] = reply["data"]["components"].clone();
    assert_eq!(empty["components"].as_array().unwrap().len(), 2);
    assert_eq!(select(&empty, 0)["options"][1]["default"], true);
    assert_eq!(empty["components"][1]["components"].as_array().unwrap().len(), 1);
    assert_eq!(empty["components"][1]["components"][0]["type"], 2);
    assert!(reply["data"]["content"].as_str().unwrap().contains("No compatible models"));

    let reply = click(&mut socket, &mut observed, 5, &empty, select(&empty, 0), Some(&json!("head"))).await;
    let head = updated(&empty, &reply, &store);
    assert_eq!(select(&head, 1)["options"], json!([
        {"label":"other","value":"0"},{"label":"✓ local","value":"1"}
    ]));

    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn head_only_model_card_defaults_to_head_and_cancel_retires_the_controls() {
    let (_temporary, store, hub, ws, mut observed, _, server) =
        discord_fixture(json!({"discord":{}})).await;
    let mut socket = addressing_tests::start(&hub, &ws, false).await;
    let route = model_route(&mut socket, &mut observed, &hub, &store).await;
    let initial = open_model_card(&hub, &mut observed, &route, "cancel-model-card", json!({})).await;
    let target = select(&initial, 0);
    assert_eq!(target["options"], json!([{"label":"HEAD","value":"head","default":true}]));
    let reply = click(&mut socket, &mut observed, 4, &initial, target, Some(&json!("lane"))).await;
    refused(&reply, &store);

    let reply = click(&mut socket, &mut observed, 5, &initial, button(&initial, "Cancel"), None).await;
    assert_eq!(reply["type"], 7);
    assert_eq!(reply["data"]["components"], json!([]));
    assert_eq!(store.pending().unwrap(), 0);
    let providers = select(&initial, 1);
    let reply = click(&mut socket, &mut observed, 6, &initial, providers, Some(&providers["options"][1]["value"])).await;
    refused(&reply, &store);

    let reopened = open_model_card(&hub, &mut observed, &route, "head-model-card", json!({})).await;
    let providers = select(&reopened, 1);
    let reply = click(&mut socket, &mut observed, 7, &reopened, providers, Some(&providers["options"][1]["value"])).await;
    let models = updated(&reopened, &reply, &store);
    let select = select(&models, 1);
    assert_ne!(select["disabled"], true, "an unbound card may select without changing scope");
    let reply = click(&mut socket, &mut observed, 8, &models, select, Some(&select["options"][1]["value"])).await;
    assert_eq!(reply["type"], 7);
    assert_eq!(reply["data"]["components"], json!([]));
    let picked = event(&hub, &store).await;
    assert_eq!(picked["input"]["route"], route);
    assert_eq!(picked["input"]["pickerSelection"],
        json!({"outputId":"head-model-card","cardId":"701","group":1,"option":1,"target":"head"}));

    hub.stop().await.unwrap();
    server.abort();
}
