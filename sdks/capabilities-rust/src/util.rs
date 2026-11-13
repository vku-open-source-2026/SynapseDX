// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Small URL helpers shared by the Tier-2 namespaces.

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use url::form_urlencoded;

const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

pub fn segment(value: &str) -> String {
    utf8_percent_encode(value, PATH_SEGMENT).to_string()
}

pub fn query_string(params: &[(&str, String)]) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in params {
        serializer.append_pair(key, value);
    }
    let encoded = serializer.finish();
    if encoded.is_empty() {
        String::new()
    } else {
        format!("?{encoded}")
    }
}

pub fn opt_param<'a>(params: &mut Vec<(&'a str, String)>, key: &'a str, value: Option<&str>) {
    if let Some(value) = value {
        params.push((key, value.to_string()));
    }
}

pub fn opt_num<T: ToString>(
    params: &mut Vec<(&'static str, String)>,
    key: &'static str,
    value: Option<T>,
) {
    if let Some(value) = value {
        params.push((key, value.to_string()));
    }
}
