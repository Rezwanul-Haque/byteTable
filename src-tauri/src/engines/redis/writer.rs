//! Redis keyspace writer: typed writes and key mutations (`KeyspaceWriter`).
//! Mirrors the `ports::keyvalue` write surface.

use async_trait::async_trait;
use redis::Value;

use crate::shared::error::AppError;
use crate::shared::keyvalue::*;

use super::error::map_query_error;
use super::RedisKvConnection;

// ---------------------------------------------------------------------------
// KeyspaceWriter
// ---------------------------------------------------------------------------

#[async_trait]
impl KeyspaceWriter for RedisKvConnection {
    async fn set_string(&self, db: u8, key: &str, value: &str) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        redis::cmd("SET")
            .arg(key)
            .arg(value)
            .query_async::<()>(&mut conn)
            .await
            .map_err(map_query_error)
    }

    async fn hash_set(&self, db: u8, key: &str, field: &str, value: &str) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        redis::cmd("HSET")
            .arg(key)
            .arg(field)
            .arg(value)
            .query_async::<i64>(&mut conn)
            .await
            .map(|_| ())
            .map_err(map_query_error)
    }

    async fn hash_del(&self, db: u8, key: &str, field: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let removed: i64 = redis::cmd("HDEL")
            .arg(key)
            .arg(field)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(removed > 0)
    }

    async fn list_set(&self, db: u8, key: &str, index: i64, value: &str) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        redis::cmd("LSET")
            .arg(key)
            .arg(index)
            .arg(value)
            .query_async::<()>(&mut conn)
            .await
            .map_err(map_query_error)
    }

    async fn set_add(&self, db: u8, key: &str, member: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let added: i64 = redis::cmd("SADD")
            .arg(key)
            .arg(member)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(added > 0)
    }

    async fn set_remove(&self, db: u8, key: &str, member: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let removed: i64 = redis::cmd("SREM")
            .arg(key)
            .arg(member)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(removed > 0)
    }

    async fn zset_add(&self, db: u8, key: &str, member: &str, score: f64) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        redis::cmd("ZADD")
            .arg(key)
            .arg(score)
            .arg(member)
            .query_async::<i64>(&mut conn)
            .await
            .map(|_| ())
            .map_err(map_query_error)
    }

    async fn zset_remove(&self, db: u8, key: &str, member: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let removed: i64 = redis::cmd("ZREM")
            .arg(key)
            .arg(member)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(removed > 0)
    }

    async fn delete_key(&self, db: u8, key: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let removed: i64 = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(removed > 0)
    }

    async fn rename_key(&self, db: u8, key: &str, new_key: &str) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        redis::cmd("RENAME")
            .arg(key)
            .arg(new_key)
            .query_async::<()>(&mut conn)
            .await
            .map_err(|err| {
                // RENAME on a missing source is `ERR no such key` → a friendlier §5.
                if err.code() == Some("ERR") {
                    AppError::NotFound(format!("Redis key '{key}' does not exist."))
                } else {
                    map_query_error(err)
                }
            })
    }

    async fn expire(&self, db: u8, key: &str, seconds: i64) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let set: i64 = redis::cmd("EXPIRE")
            .arg(key)
            .arg(seconds)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(set == 1)
    }

    async fn persist(&self, db: u8, key: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let removed: i64 = redis::cmd("PERSIST")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(removed == 1)
    }

    async fn create_key(
        &self,
        db: u8,
        key: &str,
        key_type: KeyType,
        initial: Option<&str>,
    ) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        // Map the type to its create command. The collection types need a seed
        // element so the key actually materializes (Redis has no empty keys).
        let seed = initial.unwrap_or("");
        let cmd = match key_type {
            KeyType::String => {
                let mut c = redis::cmd("SET");
                c.arg(key).arg(seed);
                c
            }
            KeyType::List => {
                let mut c = redis::cmd("RPUSH");
                c.arg(key).arg(seed);
                c
            }
            KeyType::Set => {
                let mut c = redis::cmd("SADD");
                c.arg(key).arg(seed);
                c
            }
            KeyType::Hash => {
                let mut c = redis::cmd("HSET");
                // Seed one field: `field` defaults to "field", value = seed.
                c.arg(key).arg("field").arg(seed);
                c
            }
            KeyType::Zset => {
                let mut c = redis::cmd("ZADD");
                c.arg(key).arg(0).arg(seed);
                c
            }
            KeyType::Stream => {
                let mut c = redis::cmd("XADD");
                // Seed one entry with a server id and one field.
                c.arg(key).arg("*").arg("field").arg(seed);
                c
            }
        };
        cmd.query_async::<Value>(&mut conn)
            .await
            .map(|_| ())
            .map_err(map_query_error)
    }
}
