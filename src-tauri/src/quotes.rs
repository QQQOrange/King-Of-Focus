//! 励志短语：定时联网取一条（一言 hitokoto），失败就用本地兜底

use crate::cfg;
use crate::shared::Shared;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const FALLBACK: [(&str, &str); 14] = [
    ("你今天做的事，是你明天想成为的人。", ""),
    ("专注不是天赋，是一次次把手拉回眼前的事。", ""),
    ("现在忍住的那一下，就是你以后的底气。", ""),
    ("把时间花在哪里，你就会长成什么样子。", ""),
    ("进度慢一点没关系，方向对就行。", ""),
    ("不需要靠意志力撑完，只要再撑五分钟。", ""),
    ("想放弃的时候，先把手上的这一段做完。", ""),
    ("自律的本质，是把选择权留给自己。", ""),
    ("你不是没有时间，你是把时间给了别的东西。", ""),
    ("今天先赢一小局，明天再赢一局。", ""),
    ("注意力就是你最贵的资产，别随便送人。", ""),
    ("熬得住，才配得上。", ""),
    ("安静地做，别急着要结果。", ""),
    ("所有看起来的轻松，背后都是苦功。", ""),
];

fn cache_path() -> PathBuf {
    cfg::data_dir().join("quote.json")
}

fn fetch() -> Option<(String, String)> {
    let raw = crate::net::get_text("https://v1.hitokoto.cn/?encode=json&c=d&c=i&c=k", None, None).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let text = v.get("hitokoto")?.as_str()?.trim().to_string();
    if text.is_empty() || text.chars().count() > 70 {
        return None;
    }
    // 出处尽量给全：一言同时给「作品名」和「作者」，只有作品名时也照实标。
    // 界面把它显示成 "—— 作者《作品》 · 一言"，让人一眼知道这句是从哪来的。
    let work = v.get("from").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let who = v.get("from_who").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let from = match (who.is_empty(), work.is_empty()) {
        (false, false) => format!("{who}《{work}》"),
        (false, true) => who,
        (true, false) => format!("《{work}》"),
        (true, true) => String::new(),
    };
    Some((text, from))
}

fn save_cache(text: &str, from: &str) {
    let body = serde_json::json!({"text": text, "from": from, "ts": chrono::Local::now().timestamp()});
    if let Ok(s) = serde_json::to_string(&body) {
        let _ = std::fs::write(cache_path(), s);
    }
}

fn load_cache() -> Option<(String, String)> {
    let s = std::fs::read_to_string(cache_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    Some((
        v.get("text")?.as_str()?.to_string(),
        v.get("from").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    ))
}

pub fn set_quote(shared: &Shared, text: String, from: String) {
    if let Ok(mut rt) = shared.rt.lock() {
        rt.quote = text;
        rt.quote_from = from;
    }
}

pub fn start(shared: Arc<Shared>) {
    // 先用缓存或兜底，保证第一屏就有字
    let first = load_cache().unwrap_or_else(|| {
        let i = (chrono::Local::now().timestamp() as usize) % FALLBACK.len();
        (FALLBACK[i].0.to_string(), FALLBACK[i].1.to_string())
    });
    set_quote(&shared, first.0, first.1);

    thread::spawn(move || {
        thread::sleep(Duration::from_secs(3));
        let mut idx = 0usize;
        loop {
            let cfg = shared.config();
            let mins = cfg.settings.hud.quote_minutes.clamp(5, 1440) as u64;

            let got = if cfg.settings.hud.enabled { fetch() } else { None };
            match got {
                Some((t, f)) => {
                    save_cache(&t, &f);
                    set_quote(&shared, t, f);
                }
                None => {
                    // 网络挂了：本地轮换，不至于一直显示同一句
                    idx = (idx + 1) % FALLBACK.len();
                    set_quote(&shared, FALLBACK[idx].0.to_string(), FALLBACK[idx].1.to_string());
                }
            }
            thread::sleep(Duration::from_secs(mins * 60));
        }
    });
}
