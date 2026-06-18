# Domain Model

This is the canonical domain model and entity constraint reference for the project.

Replace this stub with your domain model documentation.

## Purpose

This file defines the core domain entities, their relationships, ownership boundaries, and constraints that implementation must respect. It is the shared language between backend, frontend, and coordination.

## What belongs here

- Core domain entities and their aggregate boundaries
- Entity lifecycle states and legal transitions
- Cross-entity reference rules (which entities may reference which)
- Naming conventions and terminology glossary
- Domain invariants that must hold across all modules
- Enumeration types and their canonical values

## What does NOT belong here

- Database schemas or index strategies (those belong in repo-level migration docs)
- API payload shapes (those belong in the backend repo)
- UI component structure (those belong in the frontend repo)

## Governance Integration

Once populated:
- Implementation tickets should reference specific domain entities defined here
- Backend and frontend agents should read this before starting domain-touching work
- Changes to domain invariants require coordination-level review
