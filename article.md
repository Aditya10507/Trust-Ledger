# How I Used Hindsight to Cut Incident Diagnosis Time

The slowest part of incident response is often not finding a possible fix. It is deciding whether that fix has worked here before, on this service, under conditions close enough to trust it.

I built IncidentDNA around that distinction. Instead of sending an alert directly to a language model and hoping for a plausible answer, I retrieve the organization’s own incident history first. The model receives a small, typed set of relevant incidents and must explain the current alert using that evidence. That ordering—memory first, generation second—is the main design decision in the system.

## What IncidentDNA does

IncidentDNA is a FastAPI service with three entry points: an alert webhook, a feedback webhook, and a pull-request webhook. Alerts arrive with a service name, normalized error signature, severity, timestamp, and raw message. Pull requests arrive with the repository, service, and changed files.

The core agent has only three jobs:

1. Recall relevant incident memory through Hindsight.
2. Ask the language model for a diagnosis grounded in those memories.
3. Return a typed result to Slack or a risk comment to GitHub.

The separation is deliberate. `api.py` handles HTTP. `memory.py` owns Hindsight transport and normalization. `llm.py` owns the model request. `agent.py` owns decisions. Slack and GitHub formatting live behind integration adapters. I can test the decision path without running FastAPI or making a real network request.

I chose [Hindsight’s open-source agent memory system](https://github.com/vectorize-io/hindsight) because incident history is not merely a document-search problem. An incident contains narrative context—what changed, what failed, what engineers tried—but it also contains fields that must remain exact: service, deploy, error signature, outcome, changed files, and incident ID. I needed semantic recall without throwing away operational structure.

That distinction is central to [Vectorize’s explanation of agent memory](https://vectorize.io/what-is-agent-memory): useful memory is not just a long prompt or a transcript. It is information retained in a form that can be selectively recalled when a later decision needs it.

## The mistake I wanted to avoid

The obvious implementation is simple: paste the alert into a model and ask, “What happened?” That produces fluent troubleshooting advice. It also mixes three very different things:

- facts observed in the current alert;
- facts learned from previous incidents;
- generic knowledge inferred by the model.

During an outage, those categories cannot be allowed to blur. “Restart the service” may be reasonable general advice, but it is not the same as “INC-0142 had this signature after the same configuration change, and rollback restored service.” The second statement is auditable. The first is only plausible.

So I made recall a required phase of diagnosis. The language model never decides which historical incidents count as evidence. Hindsight does that before generation starts.

The query combines the service, normalized error signature, and raw alert text. It also filters by service:

```python
async def recall_similar_incidents(
    service: str,
    error_signature: str,
    raw_message: str,
    top_k: int = 5,
) -> list[PastIncident]:
    results = await _recall(
        f"{service} {error_signature} {raw_message}",
        top_k,
        {"service": service},
    )
    return results
```

The service filter looks conservative because it is. Pure semantic search can find an incident with nearly identical wording from an unrelated service. That may help an engineer exploring a broad failure pattern, but it is noisy input for an automated diagnosis. I would rather start with a smaller, operationally coherent set and expand recall intentionally when needed.

The [Hindsight documentation](https://hindsight.vectorize.io/) informed the boundary I built around retention and recall. The rest of the application does not know response-envelope variants, authorization headers, or retry behavior. It asks for `PastIncident` objects and gets them or a controlled failure.

## Storing narrative and metadata together

Each incident is retained twice in one memory entry: once as concise narrative content for semantic matching, and once as structured metadata for filtering and reconstruction.

```python
def _content(incident: PastIncident) -> str:
    steps = "; ".join(incident.resolution_steps)
    return (
        f"{incident.service} {incident.error_signature}. {incident.summary} "
        f"Root cause: {incident.root_cause}. Fix: {steps}"
    )

async def retain_incident(incident: PastIncident) -> None:
    metadata = incident.model_dump(
        mode="json", exclude={"relevance_score"}
    )
    await _request(
        "POST",
        "/v1/memories",
        {
            "namespace": settings.hindsight_namespace,
            "content": _content(incident),
            "metadata": metadata,
        },
    )
```

This solved a problem I have seen in search-heavy systems: treating text as the canonical record. Text is excellent for matching meaning, but bad at preserving guarantees. If the downstream code needs a Boolean `fix_worked`, a timestamp, and a list of changed files, extracting them repeatedly from prose is needless risk.

Pydantic models are the contract on both sides of memory. Missing optional fields get safe defaults, but identifiers, timestamps, and outcome fields end up in a known shape before the agent sees them. The model is not asked to repair storage inconsistencies during an outage.

## Recall is authoritative; generation is not

The most opinionated line in the agent replaces the model’s returned incident list with the incidents actually recalled from Hindsight.

```python
raw = await llm.complete(
    INCIDENT_SYSTEM_PROMPT,
    build_diagnosis_user_prompt(alert, past),
)
diagnosis = Diagnosis.model_validate_json(raw)

# Recall is authoritative — prevent model output from dropping citations.
diagnosis.similar_incidents = past
```

The prompt tells the model to copy the supplied incidents and cite their IDs. I still do not trust prompt compliance as an integrity boundary. A model may omit an inconvenient failed fix, alter a score, or return a malformed object. The retrieved set is evidence; generated text is interpretation.

This is also why the completion is validated with `Diagnosis.model_validate_json`. The result has a bounded confidence value, a list of suggested steps, reasoning, and typed incident citations. Invalid output does not leak into Slack as half-parsed text.

When generation fails, the system does not discard the useful part of the pipeline. If Hindsight returned incidents, the fallback shows the closest incident’s root cause and resolution steps with confidence set to `0.0`. If recall also returned nothing, it labels the guidance as generic. The distinction is visible to the on-call engineer.

```python
def _fallback(past: list, reason: str) -> Diagnosis:
    if past:
        best = past[0]
        return Diagnosis(
            likely_root_cause=best.root_cause,
            suggested_fix=best.resolution_steps,
            confidence=0.0,
            similar_incidents=past,
            reasoning=f"{reason}. Closest match: {best.incident_id}.",
        )
    return Diagnosis(
        likely_root_cause="No similar past incidents found.",
        suggested_fix=["Inspect recent deploys and service metrics"],
        confidence=0.0,
        similar_incidents=[],
        reasoning=reason,
    )
```

I prefer this to a transparent retry loop that keeps an alert webhook open while repeatedly asking a model for valid JSON. An outage assistant should fail into less automation, not more latency and less clarity.

## A concrete alert path

Consider a P1 alert from `checkout-service` with the signature `DBConnectionPoolExhausted`. The raw message reports a latency spike and an exhausted pool.

Hindsight recalls incidents for the same service. One memory says that deploy `1.2.3` reduced the pool from 50 connections to 10 in `config/db.yaml`; rollback and restoration of the previous pool size resolved the incident. Another incident may share the signature but have a failed fix. Both are passed to the model, including their outcomes.

The Slack response is intentionally compact:

- likely root cause: the pool-size configuration change;
- suggested steps: roll back, restore the value, verify active connections;
- confidence: a numeric value with the number of supporting incidents;
- citations: incident IDs, dates, services, and whether each fix worked;
- runbook link;
- “worked” and “didn’t work” feedback buttons.

The point is not that the system knows the root cause with certainty. It shows why a diagnosis is credible and gives the engineer a short path back to source evidence.

Feedback becomes new memory rather than an analytics event that disappears into a dashboard. The system retains whether the suggestion worked, the actual root cause, and engineer notes, linked to the alert and incident. That gives future recall an outcome signal. A failed fix remains valuable because it tells the next engineer what not to repeat.

I reuse the same memory for prevention. A pull request changing `config/db.yaml` triggers recall by changed file paths. If Hindsight finds incidents involving that file, IncidentDNA posts a GitHub table with incident IDs, services, root causes, and outcomes. This moves incident knowledge from the postmortem archive into code review, where a repeat failure can still be avoided.

## Operational behavior mattered as much as prompts

Every retain and recall emits a structured log with fields such as service, hit count, incident ID, outcome, and latency. That was not added for presentation. Memory-backed behavior is difficult to operate when the only visible output is polished prose. I want to answer: What query ran? How many memories returned? Which incident was retained? Did diagnosis fall back because recall failed or because model output was invalid?

The Hindsight client uses one shared asynchronous HTTP client, a bounded timeout, and one retry for server errors. After that, it raises a domain-specific `MemoryError`. Alert diagnosis catches that error and continues without memory; feedback retention returns an error because silently losing engineer feedback would falsely imply that the system learned something.

Those are different failure policies because the operations have different semantics. Diagnosis can degrade. A confirmed write should not pretend to succeed.

## What I learned

### 1. Retrieval should be a product decision, not a prompt detail

Choosing the query, filters, and result count determines what evidence the model can use. Hiding retrieval inside a general-purpose agent loop makes that decision harder to test and review.

### 2. Keep evidence separate from interpretation

Hindsight owns recalled records. The language model summarizes and reasons over them. Overwriting the generated citation list with the retrieved list is a small implementation detail with a large trust benefit.

### 3. Store outcomes, including failed ones

A memory of a fix that failed is not bad data. It is often the most valuable evidence available during the next incident. Outcome fields should survive retention as structured data, not as a sentence somebody must reinterpret later.

### 4. Design degraded modes before the happy path feels finished

The useful fallback was not “try the model again.” It was “show the closest verified memory, mark confidence as zero, and be explicit about what failed.” That keeps the system helpful without overstating certainty.

### 5. Put incident memory where engineers make decisions

Slack is where diagnosis happens; GitHub is where risky changes can be caught. A separate memory browser may be useful, but requiring engineers to remember to search it recreates the original problem.

The core lesson was simple: a model can explain an incident, but it should not invent the organization’s history. By putting Hindsight before generation, I turned that history into typed, inspectable evidence—and made the rest of the system easier to trust when production is already noisy.
