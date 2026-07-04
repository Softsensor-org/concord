# Security And Operability Baseline

This is the canonical security, disaster-recovery, and operability baseline for the project.

Replace this stub with your project-specific baseline.

## Purpose

This file defines the minimum security and operational expectations that all repos and environments must satisfy.

## What belongs here

- authentication and authorization baseline
- secrets and configuration handling requirements
- audit and logging expectations
- backup, restore, and recovery expectations
- operational ownership, alerting, and incident-response expectations
- availability and resilience assumptions
- server bootstrap / backfill operability expectations: read-only access to job
  logs, task status, metrics, failure reason, cleanup state, and redacted
  receipts as described in
  [`coord/product/SERVER_BOOTSTRAP_JOB_CONTRACT.md`](./SERVER_BOOTSTRAP_JOB_CONTRACT.md)

## What does NOT belong here

- ticket-level implementation notes
- sprint or milestone planning
- repo-local setup commands better captured in repo documentation

## Governance Integration

This file should stay aligned with:

- `coord/GOVERNANCE.md`
- `coord/product/TESTING_AND_GATES.md`
- `coord/product/LOCAL_AUTOMATION_AND_GATES.md`
- project-specific runbooks and environment docs
