//! DynamoDB read path: query, scan, GetItem and PartiQL statements
//! (`DocumentStoreReader`). Mirrors the `ports::document` read surface.

use std::collections::HashMap;

use async_trait::async_trait;
use aws_sdk_dynamodb::types::{AttributeValue, ReturnConsumedCapacity};
use serde_json::Value;

use crate::shared::document::*;
use crate::shared::error::AppError;

use super::error::db_err;
use super::value::{attribute_union, item_to_json, json_to_item};
use super::DynamoConnection;

/// Encode a `LastEvaluatedKey` map as an opaque JSON continuation token.
pub(super) fn encode_token(key: Option<&HashMap<String, AttributeValue>>) -> Option<String> {
    key.map(|k| item_to_json(k).to_string())
}

/// Decode a continuation token back into an `ExclusiveStartKey` map.
pub(super) fn decode_token(token: &str) -> Result<HashMap<String, AttributeValue>, AppError> {
    let value: Value = serde_json::from_str(token)
        .map_err(|e| AppError::Invalid(format!("invalid pagination token: {e}")))?;
    Ok(json_to_item(&value))
}

/// Build an `AttributeValue` for a key/condition operand, honoring the declared
/// attribute type (`N` → number, everything else → string).
pub(super) fn operand(
    attr_types: &std::collections::BTreeMap<String, String>,
    attr: &str,
    raw: &str,
) -> AttributeValue {
    match attr_types.get(attr).map(String::as_str) {
        Some("N") => AttributeValue::N(raw.to_string()),
        _ => AttributeValue::S(raw.to_string()),
    }
}

/// Build a `ProjectionExpression` + its `#p{i}` name aliases from a
/// comma-separated attribute list. Aliasing every name dodges DynamoDB reserved
/// words (e.g. `name`, `status`). Returns `None` for an empty/blank spec.
pub(super) fn build_projection(spec: Option<&str>) -> Option<(String, HashMap<String, String>)> {
    let names: Vec<&str> = spec?
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if names.is_empty() {
        return None;
    }
    let mut aliases = HashMap::new();
    let mut parts = Vec::with_capacity(names.len());
    for (i, name) in names.iter().enumerate() {
        let alias = format!("#p{i}");
        aliases.insert(alias.clone(), (*name).to_string());
        parts.push(alias);
    }
    Some((parts.join(", "), aliases))
}

#[async_trait]
impl DocumentStoreReader for DynamoConnection {
    async fn list_table_names(&self) -> Result<Vec<String>, AppError> {
        let out = self
            .client
            .list_tables()
            .send()
            .await
            .map_err(|e| db_err("List tables", e))?;
        Ok(out.table_names().to_vec())
    }

    async fn list_tables(&self) -> Result<Vec<TableDescriptor>, AppError> {
        let out = self
            .client
            .list_tables()
            .send()
            .await
            .map_err(|e| db_err("List tables", e))?;
        let names: Vec<String> = out.table_names().to_vec();
        let mut tables = Vec::with_capacity(names.len());
        for name in names {
            tables.push(self.descriptor(&name).await?);
        }
        Ok(tables)
    }

    async fn describe_table(&self, table: &str) -> Result<TableDescriptor, AppError> {
        self.descriptor(table).await
    }

    async fn scan(&self, table: &str, req: ScanRequest) -> Result<ItemPage, AppError> {
        let mut builder = self
            .client
            .scan()
            .table_name(table)
            .limit(req.limit.min(1000) as i32)
            .return_consumed_capacity(ReturnConsumedCapacity::Total);
        if let Some(token) = &req.next_token {
            builder = builder.set_exclusive_start_key(Some(decode_token(token)?));
        }
        if let Some((expr, names)) = build_projection(req.projection.as_deref()) {
            builder = builder
                .projection_expression(expr)
                .set_expression_attribute_names(Some(names));
        }
        let out = builder
            .send()
            .await
            .map_err(|e| db_err(&format!("Scan '{table}'"), e))?;

        let items: Vec<Value> = out.items().iter().map(item_to_json).collect();
        let scanned = out.scanned_count().max(0) as u64;
        let count = out.count().max(0) as u64;
        let capacity = out
            .consumed_capacity()
            .and_then(|c| c.capacity_units())
            .unwrap_or((scanned as f64) * 0.5);
        Ok(ItemPage {
            count: if count == 0 {
                items.len() as u64
            } else {
                count
            },
            scanned_count: scanned,
            capacity,
            index_name: None,
            next_token: encode_token(out.last_evaluated_key()),
            items,
        })
    }

    async fn query(&self, table: &str, req: QueryRequest) -> Result<ItemPage, AppError> {
        // Resolve the (pk, sk) attribute names + declared types for the chosen
        // index (base table when None) — exactly like the prototype.
        let desc = self.descriptor(table).await?;
        let (pk_attr, sk_attr) = match &req.index {
            Some(name) => {
                let idx = desc
                    .gsis
                    .iter()
                    .chain(desc.lsis.iter())
                    .find(|i| &i.name == name)
                    .ok_or_else(|| {
                        AppError::Invalid(format!("index '{name}' does not exist on '{table}'"))
                    })?;
                (idx.pk.clone(), idx.sk.clone())
            }
            None => (desc.key_schema.pk.clone(), desc.key_schema.sk.clone()),
        };

        let mut names = HashMap::new();
        names.insert("#pk".to_string(), pk_attr.clone());
        let mut values = HashMap::new();
        values.insert(
            ":pk".to_string(),
            operand(&desc.attr_types, &pk_attr, &req.pk_value),
        );
        let mut condition = "#pk = :pk".to_string();

        // Optional sort-key condition.
        if let (Some(op), Some(sk_name), Some(sk_val)) =
            (req.sk_op, sk_attr.as_ref(), req.sk_value.as_ref())
        {
            if !sk_val.is_empty() {
                names.insert("#sk".to_string(), sk_name.clone());
                values.insert(
                    ":sk".to_string(),
                    operand(&desc.attr_types, sk_name, sk_val),
                );
                let clause = match op {
                    SortKeyOp::Eq => "#sk = :sk".to_string(),
                    SortKeyOp::Lt => "#sk < :sk".to_string(),
                    SortKeyOp::Lte => "#sk <= :sk".to_string(),
                    SortKeyOp::Gt => "#sk > :sk".to_string(),
                    SortKeyOp::Gte => "#sk >= :sk".to_string(),
                    SortKeyOp::BeginsWith => "begins_with(#sk, :sk)".to_string(),
                    SortKeyOp::Between => {
                        let hi = req.sk_value2.clone().unwrap_or_else(|| sk_val.clone());
                        values.insert(":sk2".to_string(), operand(&desc.attr_types, sk_name, &hi));
                        "#sk BETWEEN :sk AND :sk2".to_string()
                    }
                };
                condition.push_str(" AND ");
                condition.push_str(&clause);
            }
        }

        // Projection: merge its `#p{i}` aliases into the shared names map (one
        // ExpressionAttributeNames per request) and add the expression.
        let projection = build_projection(req.projection.as_deref());
        if let Some((_, proj_names)) = &projection {
            for (alias, attr) in proj_names {
                names.insert(alias.clone(), attr.clone());
            }
        }

        let mut builder = self
            .client
            .query()
            .table_name(table)
            .key_condition_expression(condition)
            .set_expression_attribute_names(Some(names))
            .set_expression_attribute_values(Some(values))
            .limit(req.limit.min(1000) as i32)
            .return_consumed_capacity(ReturnConsumedCapacity::Total);
        if let Some((expr, _)) = projection {
            builder = builder.projection_expression(expr);
        }
        if let Some(name) = &req.index {
            builder = builder.index_name(name);
        }
        if let Some(token) = &req.next_token {
            builder = builder.set_exclusive_start_key(Some(decode_token(token)?));
        }

        let out = builder
            .send()
            .await
            .map_err(|e| db_err(&format!("Query '{table}'"), e))?;

        let items: Vec<Value> = out.items().iter().map(item_to_json).collect();
        let count = out.count().max(0) as u64;
        let capacity = out
            .consumed_capacity()
            .and_then(|c| c.capacity_units())
            .unwrap_or((items.len() as f64) * 0.5);
        Ok(ItemPage {
            count: if count == 0 {
                items.len() as u64
            } else {
                count
            },
            scanned_count: out.scanned_count().max(0) as u64,
            capacity,
            index_name: req.index,
            next_token: encode_token(out.last_evaluated_key()),
            items,
        })
    }

    async fn get_item(&self, table: &str, key: Value) -> Result<Option<Value>, AppError> {
        let out = self
            .client
            .get_item()
            .table_name(table)
            .set_key(Some(json_to_item(&key)))
            .send()
            .await
            .map_err(|e| db_err(&format!("GetItem '{table}'"), e))?;
        Ok(out.item().map(item_to_json))
    }

    async fn execute_statement(
        &self,
        statement: &str,
        next_token: Option<String>,
    ) -> Result<StatementResult, AppError> {
        let mut builder = self.client.execute_statement().statement(statement);
        if let Some(token) = next_token {
            builder = builder.next_token(token);
        }
        let out = builder
            .send()
            .await
            .map_err(|e| db_err("PartiQL statement failed", e))?;
        let items: Vec<Value> = out.items().iter().map(item_to_json).collect();
        let columns = attribute_union(&items);
        // DynamoDB plans Query vs Scan from the statement; surface a light hint
        // (a WHERE on the partition key plans a Query).
        let op = if statement.to_lowercase().contains(" where ") {
            "Query"
        } else {
            "Scan"
        };
        Ok(StatementResult {
            count: items.len() as u64,
            columns,
            op: op.to_string(),
            next_token: out.next_token().map(str::to_string),
            items,
        })
    }
}
