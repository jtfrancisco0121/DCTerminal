use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

/// The id of a JSON-RPC request the agent sent us. JSON-RPC allows a number
/// or a string; the answer must echo it back unchanged, so both are kept as
/// they came. Serialises as the bare number or string (the UI sees the same).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    Text(String),
}

impl RequestId {
    /// The request id in `value["id"]`, or `None` when it is missing, null or
    /// not a non-negative integer or string (then the line is a notification).
    pub fn from_message(value: &Value) -> Option<Self> {
        Self::from_value(value.get("id")?)
    }

    pub fn from_value(id: &Value) -> Option<Self> {
        match id {
            Value::Number(n) => n.as_u64().map(Self::Number),
            Value::String(s) => Some(Self::Text(s.clone())),
            _ => None,
        }
    }

    /// The id as JSON, exactly as the agent sent it.
    pub fn to_value(&self) -> Value {
        match self {
            Self::Number(n) => Value::from(*n),
            Self::Text(s) => Value::from(s.as_str()),
        }
    }
}

impl From<u64> for RequestId {
    fn from(id: u64) -> Self {
        Self::Number(id)
    }
}

impl From<&str> for RequestId {
    fn from(id: &str) -> Self {
        Self::Text(id.to_string())
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number(n) => write!(f, "{n}"),
            Self::Text(s) => f.write_str(s),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RequestId;
    use serde_json::json;

    #[test]
    fn numeric_and_string_ids_round_trip_unchanged() {
        let num = RequestId::from_message(&json!({ "id": 7, "method": "x" })).unwrap();
        assert_eq!(num, RequestId::Number(7));
        assert_eq!(num.to_value(), json!(7));
        assert_eq!(serde_json::to_value(&num).unwrap(), json!(7));

        let text = RequestId::from_message(&json!({ "id": "req-7", "method": "x" })).unwrap();
        assert_eq!(text, RequestId::Text("req-7".into()));
        assert_eq!(text.to_value(), json!("req-7"));
        assert_eq!(serde_json::to_value(&text).unwrap(), json!("req-7"));

        // What the UI sends back deserialises to the same id.
        assert_eq!(serde_json::from_value::<RequestId>(json!(7)).unwrap(), num);
        assert_eq!(serde_json::from_value::<RequestId>(json!("req-7")).unwrap(), text);
        // "7" the string is not 7 the number.
        assert_ne!(RequestId::from_value(&json!("7")), Some(num));
    }

    #[test]
    fn missing_or_null_ids_are_notifications() {
        assert_eq!(RequestId::from_message(&json!({ "method": "x" })), None);
        assert_eq!(RequestId::from_message(&json!({ "id": null, "method": "x" })), None);
    }
}
