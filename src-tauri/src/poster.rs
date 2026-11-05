//! 战报图：把前端 canvas 画好的 PNG 存到用户选的位置。
//!
//! 为什么要绕一圈经过 Rust：浏览器里 `a[download]` 在 Tauri 的 WebView 里
//! 不可靠（没有下载管理器），而且用户要的是"存到桌面/图片文件夹"，
//! 这必须走系统保存对话框。
//!
//! 只做两件事：解析 `data:image/png;base64,...`、写文件。
//! base64 解码自己实现（30 行），不为了这一处引入一个 crate。

const PREFIX: &str = "data:image/png;base64,";

/// 把 canvas 给的 data URL 解成 PNG 字节。
pub fn decode_png_data_url(s: &str) -> Result<Vec<u8>, String> {
    let body = s
        .strip_prefix(PREFIX)
        .ok_or_else(|| "不是 PNG 图片数据".to_string())?;
    decode_b64(body)
}

fn decode_b64(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4 + 3);
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,          // 填充：后面不会再有有效数据
            b'\n' | b'\r' | b' ' => continue,
            _ => return Err(format!("图片数据里有非法字符：{}", c as char)),
        };
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    if out.is_empty() {
        return Err("图片数据为空".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解码基本串() {
        assert_eq!(b"hello".to_vec(), decode_b64("aGVsbG8=").unwrap());
        assert_eq!(b"hi".to_vec(), decode_b64("aGk=").unwrap());
    }

    #[test]
    fn 容忍换行与空格() {
        assert_eq!(b"hello".to_vec(), decode_b64("aGVs\nbG8 =").unwrap());
    }

    #[test]
    fn 非法字符要报错而不是静默产出坏图() {
        assert!(decode_b64("aGV*sbG8=").is_err());
    }

    #[test]
    fn 只接受png的dataurl() {
        assert!(decode_png_data_url("data:image/jpeg;base64,AAAA").is_err());
        assert!(decode_png_data_url("data:image/png;base64,aGk=").is_ok());
    }
}
