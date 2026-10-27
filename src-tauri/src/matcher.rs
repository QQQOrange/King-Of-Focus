use crate::model::{AppEntry, RuleList};
use crate::proc::{norm_path, stem, WinApp};

/// 大小写不敏感的通配符匹配，支持 * 和 ?
pub fn glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == t[ti] || p[pi] == '?') {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            pi += 1;
            mark = ti;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn contains_nocase(hay: &str, needle: &str) -> bool {
    hay.to_lowercase().contains(&needle.to_lowercase())
}

pub fn app_matches(entry: &AppEntry, app: &WinApp) -> bool {
    let v = entry.value.trim();
    if v.is_empty() {
        return false;
    }
    match entry.kind.as_str() {
        "exe" => {
            if app.path.is_empty() {
                // 拿不到路径时退化为进程名匹配
                let file = v.rsplit(['\\', '/']).next().unwrap_or(v);
                return stem(file) == app.name || glob(&stem(file), &app.name);
            }
            norm_path(&app.path) == norm_path(v)
        }
        "dir" => {
            let dir = norm_path(v);
            if app.path.is_empty() {
                return false;
            }
            norm_path(&app.path).starts_with(&dir)
        }
        "name" => {
            if v.contains('*') || v.contains('?') {
                glob(v, &app.name)
            } else {
                stem(v) == app.name
            }
        }
        "title" => {
            if v.contains('*') || v.contains('?') {
                glob(v, &app.title)
            } else {
                contains_nocase(&app.title, v)
            }
        }
        _ => false,
    }
}

pub fn rule_blocks_app(rule: &RuleList, app: &WinApp) -> bool {
    rule.apps.iter().any(|e| app_matches(e, app))
}

/// 强制模式下，这个进程是否"该被放行"
pub fn rule_allows_app(rule: &RuleList, app: &WinApp) -> bool {
    rule.apps.iter().any(|e| app_matches(e, app))
}

/// 是否属于"系统级 / 保护"进程，任何情况下都不拦
pub fn is_protected(app: &WinApp, protected: &[String]) -> bool {
    if app.path.is_empty() {
        return true; // 拿不到路径的一律放过，避免误杀
    }
    let p = norm_path(&app.path);
    if p.starts_with("c:\\windows\\") {
        return true; // 系统目录里的进程一律放过
    }
    if protected.iter().any(|n| n.to_lowercase() == app.name) {
        return true;
    }
    if app.name.is_empty() {
        return true;
    }
    false
}

pub const BROWSERS: [&str; 16] = [
    "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "chromium", "360se",
    "360chrome", "qqbrowser", "sogouexplorer", "liebao", "maxthon", "arc", "thorium",
    "zen",
];

pub fn is_browser(app: &WinApp) -> bool {
    BROWSERS.iter().any(|b| app.name.contains(b))
}
