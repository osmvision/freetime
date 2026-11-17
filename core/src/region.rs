//! Country and currency from the operating system's regional settings. No network involved.

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Region {
    /// ISO 3166-1 alpha-2, upper case ("FR").
    pub country: Option<String>,
    /// ISO 4217 ("EUR").
    pub currency: Option<String>,
}

/// The user's region as set in Windows (Settings → Time & language → Region).
pub fn current() -> Region {
    let country = os_country();
    let currency = os_currency()
        .or_else(|| country.as_deref().and_then(crate::location::currency_for).map(String::from));
    Region { country, currency }
}

#[cfg(windows)]
fn os_country() -> Option<String> {
    use windows_sys::Win32::Globalization::{GetUserDefaultGeoName, GetUserDefaultLocaleName};
    let mut geo = [0u16; 16];
    // SAFETY: the buffer and its length match; the call writes at most that many UTF-16 units.
    let n = unsafe { GetUserDefaultGeoName(geo.as_mut_ptr(), geo.len() as i32) };
    if let Some(code) = utf16(&geo, n).and_then(|g| country_code(&g)) {
        return Some(code);
    }
    // The home location can be a whole region ("001"); the locale name still has a country.
    let mut locale = [0u16; 85];
    // SAFETY: as above.
    let n = unsafe { GetUserDefaultLocaleName(locale.as_mut_ptr(), locale.len() as i32) };
    utf16(&locale, n).and_then(|l| region_of_locale(&l))
}

#[cfg(windows)]
fn os_currency() -> Option<String> {
    use windows_sys::Win32::Globalization::{GetLocaleInfoEx, LOCALE_SINTLSYMBOL};
    let mut buf = [0u16; 16];
    // SAFETY: a null locale name means the user's default locale; buffer and length match.
    let n = unsafe { GetLocaleInfoEx(std::ptr::null(), LOCALE_SINTLSYMBOL, buf.as_mut_ptr(), buf.len() as i32) };
    utf16(&buf, n).and_then(|c| currency_code(&c))
}

/// A buffer filled by a Win32 call returning the length including the terminating NUL.
#[cfg(windows)]
fn utf16(buf: &[u16], written: i32) -> Option<String> {
    let len = usize::try_from(written).ok()?.checked_sub(1)?;
    (len > 0 && len <= buf.len()).then(|| String::from_utf16_lossy(&buf[..len]))
}

#[cfg(not(windows))]
fn os_country() -> Option<String> {
    ["LC_ALL", "LC_MONETARY", "LANG"].iter().filter_map(|v| std::env::var(v).ok()).find_map(|l| region_of_locale(&l))
}

#[cfg(not(windows))]
fn os_currency() -> Option<String> {
    None
}

/// "FR" → FR. A UN M.49 area code like "001" is not a country.
pub fn country_code(s: &str) -> Option<String> {
    let s = s.trim();
    (s.len() == 2 && s.bytes().all(|b| b.is_ascii_alphabetic())).then(|| s.to_ascii_uppercase())
}

fn currency_code(s: &str) -> Option<String> {
    let s = s.trim();
    (s.len() == 3 && s.bytes().all(|b| b.is_ascii_alphabetic())).then(|| s.to_ascii_uppercase())
}

/// The country part of a locale name: "fr-FR" → FR, "zh-Hans-CN" → CN, "fr_FR.UTF-8" → FR.
pub fn region_of_locale(locale: &str) -> Option<String> {
    let base = locale.split(['.', '@']).next()?;
    base.split(['-', '_']).skip(1).find_map(country_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn country_from_locale_names() {
        assert_eq!(region_of_locale("fr-FR").as_deref(), Some("FR"));
        assert_eq!(region_of_locale("en-us").as_deref(), Some("US"));
        assert_eq!(region_of_locale("zh-Hans-CN").as_deref(), Some("CN"));
        assert_eq!(region_of_locale("fr_FR.UTF-8").as_deref(), Some("FR"));
        assert_eq!(region_of_locale("es-419"), None);
        assert_eq!(region_of_locale("fr"), None);
        assert_eq!(region_of_locale(""), None);
    }

    #[test]
    fn country_and_currency_codes() {
        assert_eq!(country_code(" gb ").as_deref(), Some("GB"));
        assert_eq!(country_code("001"), None);
        assert_eq!(currency_code("eur").as_deref(), Some("EUR"));
        assert_eq!(currency_code("€"), None);
    }

    #[test]
    fn reading_the_os_region_never_fails() {
        let region = current();
        if let Some(c) = &region.country {
            assert!(country_code(c).is_some(), "{c}");
        }
    }
}
