use s3::creds::Credentials;
use s3::{Bucket, Region};

use crate::explorer::types::{DirEntry, S3Config};

fn build_bucket(config: &S3Config) -> Result<Box<Bucket>, String> {
    let creds = Credentials::new(
        Some(&config.access_key),
        Some(&config.secret_key),
        None,
        None,
        None,
    )
    .map_err(|e| format!("s3 credential error: {}", e))?;

    let region = match config.endpoint.as_ref() {
        Some(ep) if !ep.is_empty() => Region::Custom {
            region: config.region.clone(),
            endpoint: ep.clone(),
        },
        _ => config
            .region
            .parse()
            .map_err(|e| format!("s3 region parse error: {}", e))?,
    };

    let bucket = Bucket::new(&config.bucket, region, creds)
        .map_err(|e| format!("s3 bucket creation error: {}", e))?;

    if config.force_path_style {
        Ok(bucket.with_path_style())
    } else {
        Ok(bucket)
    }
}

fn s3_timestamp_to_unix(timestamp: &str) -> i64 {
    if timestamp.len() < 20 {
        return 0;
    }
    let year: i64 = timestamp[0..4].parse().unwrap_or(0);
    let month: i64 = timestamp[5..7].parse().unwrap_or(1);
    let day: i64 = timestamp[8..10].parse().unwrap_or(1);
    let hour: i64 = timestamp[11..13].parse().unwrap_or(0);
    let min: i64 = timestamp[14..16].parse().unwrap_or(0);
    let sec: i64 = timestamp[17..19].parse().unwrap_or(0);

    let days_epoch = |y: i64, m: i64, d: i64| -> i64 {
        let (y, m) = if m <= 2 { (y - 1, m + 12) } else { (y, m) };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let doy = (153 * (m - 3) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146097 + doe - 719468
    };

    let days = days_epoch(year, month, day);
    days * 86400 + hour * 3600 + min * 60 + sec
}

pub async fn s3_list_directory(config: &S3Config, path: &str) -> Result<Vec<DirEntry>, String> {
    let bucket = build_bucket(config)?;
    let prefix = path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_string();
    let prefix = if prefix.is_empty() || prefix == "/" {
        String::new()
    } else {
        format!("{}/", prefix)
    };

    let results = bucket
        .list(prefix.clone(), Some("/".to_string()))
        .await
        .map_err(|e| format!("s3 list error: {}", e))?;

    let mut entries = Vec::new();

    for result in &results {
        for item in &result.contents {
            let key = &item.key;
            let name = key
                .strip_prefix(&prefix)
                .unwrap_or(key)
                .trim_end_matches('/')
                .to_string();
            if name.is_empty() {
                continue;
            }

            entries.push(DirEntry {
                name,
                path: format!("/{}", key),
                is_dir: false,
                is_symlink: false,
                size: item.size,
                modified: s3_timestamp_to_unix(&item.last_modified),
                permissions: None,
            });
        }

        for cp in result.common_prefixes.iter().flatten() {
            let cp_prefix = cp.prefix.trim_end_matches('/');
            let name = cp_prefix
                .rsplit('/')
                .next()
                .unwrap_or(cp_prefix)
                .to_string();
            if name.is_empty() {
                continue;
            }

            entries.push(DirEntry {
                name,
                path: format!("/{}", cp_prefix),
                is_dir: true,
                is_symlink: false,
                size: 0,
                modified: 0,
                permissions: None,
            });
        }
    }

    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));

    Ok(entries)
}

pub async fn s3_read_file_bytes(config: &S3Config, path: &str) -> Result<Vec<u8>, String> {
    let bucket = build_bucket(config)?;
    let key = path.trim_start_matches('/');
    let data = bucket
        .get_object(key)
        .await
        .map_err(|e| format!("s3 get error: {}", e))?;
    if data.status_code() != 200 {
        return Err(format!("s3 get returned status {}", data.status_code()));
    }
    Ok(data.bytes().to_vec())
}

pub async fn s3_read_file(config: &S3Config, path: &str) -> Result<String, String> {
    let bucket = build_bucket(config)?;
    let key = path.trim_start_matches('/');

    let data = bucket
        .get_object(key)
        .await
        .map_err(|e| format!("s3 get error: {}", e))?;

    if data.status_code() != 200 {
        return Err(format!("s3 get returned status {}", data.status_code()));
    }

    String::from_utf8(data.bytes().to_vec()).map_err(|e| format!("s3 read utf8 error: {}", e))
}

pub async fn s3_write_file(config: &S3Config, path: &str, content: &str) -> Result<(), String> {
    let bucket = build_bucket(config)?;
    let key = path.trim_start_matches('/');

    let data = bucket
        .put_object(key, content.as_bytes())
        .await
        .map_err(|e| format!("s3 put error: {}", e))?;

    if data.status_code() != 200 {
        return Err(format!("s3 put returned status {}", data.status_code()));
    }

    Ok(())
}

pub async fn s3_delete_entry(config: &S3Config, path: &str) -> Result<(), String> {
    let bucket = build_bucket(config)?;
    let key = path.trim_start_matches('/');

    if path.ends_with('/') || path.is_empty() {
        let results = bucket
            .list(key.to_string(), None)
            .await
            .map_err(|e| format!("s3 list for delete error: {}", e))?;

        for result in &results {
            for item in &result.contents {
                bucket
                    .delete_object(&item.key)
                    .await
                    .map_err(|e| format!("s3 delete object '{}' error: {}", item.key, e))?;
            }
        }

        let marker_key = key.trim_end_matches('/');
        if !marker_key.is_empty() {
            let _ = bucket.delete_object(marker_key).await;
            let _ = bucket.delete_object(&format!("{}/", marker_key)).await;
        }
    } else {
        bucket
            .delete_object(key)
            .await
            .map_err(|e| format!("s3 delete error: {}", e))?;
    }

    Ok(())
}

pub async fn s3_rename_entry(config: &S3Config, from: &str, to: &str) -> Result<(), String> {
    let bucket = build_bucket(config)?;
    let from_key = from.trim_start_matches('/').trim_end_matches('/');
    let to_key = to.trim_start_matches('/').trim_end_matches('/');

    let results = bucket
        .list(format!("{}/", from_key), None)
        .await
        .map_err(|e| format!("s3 list for rename error: {}", e))?;

    let mut objects_to_copy = vec![from_key.to_string()];

    for result in &results {
        for item in &result.contents {
            if !objects_to_copy.contains(&item.key) {
                objects_to_copy.push(item.key.clone());
            }
        }
    }

    for src_key in &objects_to_copy {
        let suffix = src_key
            .strip_prefix(&format!("{}/", from_key))
            .or_else(|| if src_key == from_key { Some("") } else { None })
            .unwrap_or("");

        let dst_key = if suffix.is_empty() {
            to_key.to_string()
        } else {
            format!("{}/{}", to_key, suffix)
        };

        let code = bucket
            .copy_object_internal(src_key, &dst_key)
            .await
            .map_err(|e| format!("s3 copy '{}' -> '{}' error: {}", src_key, dst_key, e))?;

        if code != 200 {
            return Err(format!(
                "s3 copy returned status {} for '{}' -> '{}'",
                code, src_key, dst_key
            ));
        }

        bucket
            .delete_object(src_key)
            .await
            .map_err(|e| format!("s3 delete after copy '{}' error: {}", src_key, e))?;
    }

    Ok(())
}

pub async fn s3_create_directory(config: &S3Config, path: &str) -> Result<(), String> {
    let bucket = build_bucket(config)?;
    let key = path.trim_start_matches('/').trim_end_matches('/');

    if key.is_empty() {
        return Err("cannot create root directory".to_string());
    }

    let marker_key = format!("{}/", key);
    let data = bucket
        .put_object(&marker_key, b"")
        .await
        .map_err(|e| format!("s3 create directory error: {}", e))?;

    if data.status_code() != 200 {
        return Err(format!(
            "s3 create directory returned status {}",
            data.status_code()
        ));
    }

    Ok(())
}
