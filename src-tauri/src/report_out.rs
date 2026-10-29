//! 报告导出：Markdown / 纯文本 / Word(.docx)
//!
//! 三种格式读的是**同一份中间结构** `Blk`，所以标题层级、段落、列表缩进
//! 在哪一种里都不会走样；也避免出现"Markdown 里有二级标题、txt 里变成一行字"。
//!
//! 为什么要自己写 .docx：整个程序没有 zip 依赖，而 .docx 就是一个 zip 包。
//! 这里只用到「不压缩（store）」这一种存储方式，DOCX 规范完全允许，
//! Word / WPS / LibreOffice 都能正常打开。用 store 的好处是不需要 deflate 实现，
//! 代码量和出错面都小得多。

use crate::stats::Report;

/// 导出内容的最小结构单元 —— 三种格式都从这里渲染
#[derive(Debug, Clone, PartialEq)]
pub enum Blk {
    H1(String),
    H2(String),
    P(String),
    /// 列表项：depth 0 = 一级，1 = 二级
    Li(usize, String),
}

fn hhmm(secs: u64) -> String {
    let m = secs / 60;
    let h = m / 60;
    let mm = m % 60;
    if h > 0 && mm > 0 {
        format!("{h} 小时 {mm} 分")
    } else if h > 0 {
        format!("{h} 小时")
    } else {
        format!("{mm} 分钟")
    }
}

fn pct(part: u64, total: u64) -> String {
    if total == 0 {
        return "0.0%".into();
    }
    format!("{:.1}%", part as f64 * 100.0 / total as f64)
}

fn cat_name(c: &str) -> &'static str {
    match c {
        "site" => "网站",
        "app" => "程序",
        _ => "其他",
    }
}

fn period_name(p: &str) -> &'static str {
    match p {
        "daily" => "日报",
        "weekly" => "周报",
        "monthly" => "月报",
        "yearly" => "年报",
        _ => "自定义报告",
    }
}

fn ts_text(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "-".into())
}

/// 报告 → 结构块。标题 / 总览 / 两类分布 / 说明，顺序固定，便于长期存档对比。
pub fn blocks(r: &Report) -> Vec<Blk> {
    let total = r.on_secs + r.off_secs;
    let mut v = vec![
        Blk::H1(r.title.clone()),
        Blk::P(format!(
            "{}　|　统计区间 {} ~ {}　|　生成于 {}",
            period_name(&r.period),
            r.start,
            r.end,
            ts_text(r.created)
        )),
        Blk::H2("时长总览".into()),
        Blk::Li(0, format!("自律模式已开启：{}", hhmm(r.on_secs))),
        Blk::Li(0, format!("自律模式未开启：{}", hhmm(r.off_secs))),
        Blk::Li(0, format!("合计：{}", hhmm(total))),
        Blk::Li(0, format!("开启占比：{}", pct(r.on_secs, total))),
    ];

    // 两侧各自按"分类 → 条目"两层列出，列表层级就是分类与明细的关系
    let push_side = |v: &mut Vec<Blk>, name: &str, list: &[crate::stats::Slice], tot: u64| {
        v.push(Blk::H2(name.into()));
        if list.is_empty() {
            v.push(Blk::P("这一段时间里没有记录到任何活动。".into()));
            return;
        }
        // 分类汇总（保持首次出现顺序，时间和从大到小排）
        let mut cats: Vec<(String, u64)> = Vec::new();
        for s in list {
            let c = cat_name(&s.category).to_string();
            match cats.iter_mut().find(|(k, _)| *k == c) {
                Some(e) => e.1 += s.secs,
                None => cats.push((c, s.secs)),
            }
        }
        cats.sort_by(|a, b| b.1.cmp(&a.1));
        for (c, secs) in cats {
            v.push(Blk::Li(0, format!("{c}：{}（{}）", hhmm(secs), pct(secs, tot.max(1)))));
            // 该分类下的明细，按占用时间从多到少，最多 8 条
            let mut rows: Vec<&crate::stats::Slice> =
                list.iter().filter(|s| cat_name(&s.category) == c).collect();
            rows.sort_by(|a, b| b.secs.cmp(&a.secs));
            for s in rows.iter().take(8) {
                v.push(Blk::Li(
                    1,
                    format!("{} — {}（{}）", s.label, hhmm(s.secs), pct(s.secs, tot.max(1))),
                ));
            }
            if rows.len() > 8 {
                v.push(Blk::Li(1, format!("…… 另有 {} 项未列出", rows.len() - 8)));
            }
        }
    };
    push_side(&mut v, "开启时段的分布", &r.on, r.on_secs);
    push_side(&mut v, "未开启时段的分布", &r.off, r.off_secs);

    v.push(Blk::H2("说明".into()));
    v.push(Blk::P(
        "本报告由 King of Focus 在本地按小时采样生成，不包含任何窗口标题或网页内容，只统计程序名与域名。"
            .into(),
    ));
    v.push(Blk::P(
        "「已开启」指自律模式生效（自律规则命中 / 自律时段专注中 / 固化锁定，三者任一成立）。".into(),
    ));
    v.push(Blk::P(format!("导出时间：{}", ts_text(chrono::Local::now().timestamp()))));
    v
}

// ---------------- Markdown ----------------

pub fn markdown(bs: &[Blk]) -> String {
    let mut s = String::new();
    // 标题前必须有空行，否则紧跟在列表后面会变成"列表项 + ## 标题"同一段。
    // 以前是用 `s.replace("\n## ", ...)` 事后补救——正文里只要恰好出现
    // "\n## " 就会被误伤，这里改成写出时判断。
    let blank = |s: &mut String| {
        if !s.is_empty() && !s.ends_with("\n\n") {
            s.push('\n');
        }
    };
    for b in bs {
        match b {
            Blk::H1(t) => {
                blank(&mut s);
                s.push_str(&format!("# {t}\n\n"));
            }
            Blk::H2(t) => {
                blank(&mut s);
                s.push_str(&format!("## {t}\n\n"));
            }
            Blk::P(t) => {
                blank(&mut s);
                s.push_str(&format!("{t}\n\n"));
            }
            Blk::Li(d, t) => s.push_str(&format!("{}- {t}\n", "  ".repeat(*d))),
        }
    }
    format!("{}\n", s.trim_end())
}

// ---------------- 纯文本 ----------------

pub fn plain(bs: &[Blk]) -> String {
    let mut s = String::new();
    for b in bs {
        match b {
            Blk::H1(t) => {
                s.push_str(&format!("{t}\n{}\n\n", "=".repeat(t.chars().count().max(4))));
            }
            Blk::H2(t) => s.push_str(&format!("【{t}】\n")),
            Blk::P(t) => s.push_str(&format!("{t}\n\n")),
            Blk::Li(d, t) => {
                s.push_str(&format!("{}{} {}\n", "    ".repeat(*d), if *d == 0 { "·" } else { "–" }, t));
            }
        }
    }
    format!("{}\n", s.trim_end())
}

// ---------------- Word (.docx) ----------------

fn xml_esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            // 控制字符在 XML 里非法，直接丢掉（报告标题里一般不会有）
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => {}
            c => o.push(c),
        }
    }
    o
}

fn para(style: Option<&str>, ind_left: i32, text: &str) -> String {
    let ppr = match (style, ind_left) {
        (Some(st), 0) => format!("<w:pPr><w:pStyle w:val=\"{st}\"/></w:pPr>"),
        (Some(st), n) => {
            format!("<w:pPr><w:pStyle w:val=\"{st}\"/><w:ind w:left=\"{n}\"/></w:pPr>")
        }
        (None, 0) => String::new(),
        (None, n) => format!("<w:pPr><w:ind w:left=\"{n}\"/></w:pPr>"),
    };
    format!(
        "<w:p>{ppr}<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        xml_esc(text)
    )
}

fn document_xml(bs: &[Blk]) -> String {
    let mut body = String::new();
    for b in bs {
        match b {
            Blk::H1(t) => body.push_str(&para(Some("Heading1"), 0, t)),
            Blk::H2(t) => body.push_str(&para(Some("Heading2"), 0, t)),
            Blk::P(t) => body.push_str(&para(None, 0, t)),
            // 列表用「项目符号 + 缩进」表达层级：不引入 numbering.xml，
            // Word / WPS 打开后就是标准的两级项目符号列表，复制出去也不散。
            Blk::Li(d, t) => {
                let mark = if *d == 0 { "·" } else { "–" };
                body.push_str(&para(Some("ListParagraph"), 360 * (*d as i32 + 1), &format!("{mark} {t}")));
            }
        }
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1304" w:bottom="1440" w:left="1304" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    )
}

const STYLES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F2A44"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2F3B55"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/></w:pPr></w:style>
</w:styles>"#;

fn content_types_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>"#
}

fn rels_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#
}

fn doc_rels_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#
}

// ---------------- 极简 ZIP（store，不压缩） ----------------

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn put16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}

/// 打成 .docx（zip）。条目全部用 store，顺序固定：
/// [Content_Types].xml → _rels/.rels → word/document.xml → word/styles.xml → word/_rels/document.xml.rels
pub fn docx(bs: &[Blk]) -> Vec<u8> {
    let files: Vec<(String, Vec<u8>)> = vec![
        ("[Content_Types].xml".into(), content_types_xml().as_bytes().to_vec()),
        ("_rels/.rels".into(), rels_xml().as_bytes().to_vec()),
        ("word/document.xml".into(), document_xml(bs).into_bytes()),
        ("word/styles.xml".into(), STYLES_XML.as_bytes().to_vec()),
        ("word/_rels/document.xml.rels".into(), doc_rels_xml().as_bytes().to_vec()),
    ];

    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, data) in files.iter() {
        let nb = name.as_bytes();
        let crc = crc32(data);
        let off = out.len() as u32;
        // local file header
        put32(&mut out, 0x0403_4b50);
        put16(&mut out, 20);            // version needed
        put16(&mut out, 0x0800);        // UTF-8 文件名
        put16(&mut out, 0);             // method = store
        put16(&mut out, 0);             // time
        put16(&mut out, 0x21);          // date = 1980-01-01
        put32(&mut out, crc);
        put32(&mut out, data.len() as u32);
        put32(&mut out, data.len() as u32);
        put16(&mut out, nb.len() as u16);
        put16(&mut out, 0);             // extra len
        out.extend_from_slice(nb);
        out.extend_from_slice(data);

        // central directory record
        put32(&mut central, 0x0201_4b50);
        put16(&mut central, 20);        // version made by
        put16(&mut central, 20);        // version needed
        put16(&mut central, 0x0800);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put16(&mut central, 0x21);
        put32(&mut central, crc);
        put32(&mut central, data.len() as u32);
        put32(&mut central, data.len() as u32);
        put16(&mut central, nb.len() as u16);
        put16(&mut central, 0);         // extra
        put16(&mut central, 0);         // comment
        put16(&mut central, 0);         // disk
        put16(&mut central, 0);         // internal attrs
        put32(&mut central, 0);         // external attrs
        put32(&mut central, off);
        central.extend_from_slice(nb);
    }
    let cd_off = out.len() as u32;
    let cd_size = central.len() as u32;
    out.extend_from_slice(&central);
    // end of central directory
    put32(&mut out, 0x0605_4b50);
    put16(&mut out, 0);
    put16(&mut out, 0);
    put16(&mut out, files.len() as u16);
    put16(&mut out, files.len() as u16);
    put32(&mut out, cd_size);
    put32(&mut out, cd_off);
    put16(&mut out, 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::Slice;

    fn sample() -> Report {
        Report {
            id: "daily_2026-10-27_2026-10-27".into(),
            period: "daily".into(),
            title: "2026-10-27 日报".into(),
            start: "2026-10-27".into(),
            end: "2026-10-27".into(),
            created: 1_767_000_000,
            on_secs: 11_700,
            off_secs: 74_700,
            on: vec![
                Slice { key: "app|code.exe".into(), label: "Code".into(), category: "app".into(), secs: 7_200 },
                Slice { key: "site|github.com".into(), label: "github.com".into(), category: "site".into(), secs: 4_500 },
            ],
            off: vec![Slice { key: "app|chrome.exe".into(), label: "Chrome".into(), category: "app".into(), secs: 74_700 }],
        }
    }

    #[test]
    fn markdown_keeps_heading_and_list_levels() {
        let md = markdown(&blocks(&sample()));
        assert!(md.starts_with("# 2026-10-27 日报"));
        assert!(md.contains("\n## 时长总览"));
        assert!(md.contains("\n- 自律模式已开启：3 小时 15 分"));
        // 二级列表缩进两个空格
        assert!(md.contains("\n  - Code — 2 小时"));
    }

    #[test]
    fn plain_has_no_markdown_marks() {
        let txt = plain(&blocks(&sample()));
        assert!(!txt.contains("## "));
        assert!(txt.contains("【时长总览】"));
        assert!(txt.contains("· 自律模式已开启"));
        assert!(txt.contains("\n    – "));
    }

    #[test]
    fn docx_is_a_valid_zip_with_expected_parts() {
        let data = docx(&blocks(&sample()));
        // 本地文件头
        assert_eq!(&data[0..4], &[0x50, 0x4b, 0x03, 0x04]);
        // 中央目录结束记录
        assert!(data.windows(4).any(|w| w == [0x50, 0x4b, 0x05, 0x06]));
        let s = String::from_utf8_lossy(&data);
        for part in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "word/styles.xml",
            "word/_rels/document.xml.rels",
        ] {
            assert!(s.contains(part), "缺少 {part}");
        }
        // 文档正文里标题样式与列表缩进都在
        assert!(s.contains("Heading1"));
        assert!(s.contains("w:ind w:left=\"720\""));
    }

    #[test]
    fn crc32_matches_known_value() {
        // "123456789" 的 CRC32 标准值
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    /// 真落一个文件到临时目录，供外部（python zipfile / Word）验证能不能打开。
    /// 文件名固定，跑完不删也不影响用户数据 —— 只在系统临时目录里。
    #[test]
    fn docx_file_can_be_written() {
        let p = std::env::temp_dir().join("kof_export_sample.docx");
        std::fs::write(&p, docx(&blocks(&sample()))).expect("写 docx");
        let n = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        assert!(n > 1000, "docx 太小：{n}");
    }
}
