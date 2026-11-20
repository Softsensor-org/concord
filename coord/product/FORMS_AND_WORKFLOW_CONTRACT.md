# Forms and Workflow Contract

This is the canonical forms and workflow runtime contract for the project.

Replace this stub with your project-specific forms and workflow definitions.

## Purpose

This file defines the shared contract for dynamic forms, workflow state machines, and process orchestration. It ensures that backend and frontend agree on form structure, validation rules, and workflow lifecycle.

## What belongs here

### Form Contracts

- Form definition schema (fields, types, validation rules)
- Dynamic form rendering contract between backend and frontend
- Conditional field visibility and branching logic
- File attachment and media handling contracts

### Workflow Contracts

- State machine definitions for business processes
- Legal state transitions and guard conditions
- Approval and escalation chains
- Timer and deadline handling

### Shared Runtime

- Form and workflow versioning strategy
- Configuration-driven vs code-driven boundaries
- Template and instance lifecycle

## Governance Integration

Once populated:
- Workflow-touching tickets should reference specific state machines or form definitions here
- Backend and frontend agents must implement the same contract
- Changes to shared workflow contracts require coordination-level review
