# Question tool

The tool has a strict argument schema. Its `questions` parameter must always be an array of question objects. Never pass a string, paragraph, summary, plan or other plain text as the value of `questions`.

## Required structure

Every question object must contain:

- `question`: the actual question being asked.
- `header`: a short title identifying the subject.
- `options`: an array of available answers.

For free-form answers, use an empty `options` array.

For predefined choices, each option must contain:
- `label`: the option's visible name.
- `description`: a brief explanation of the option.

For single-choice questions, set `multiple` to `false`.

For multiple-choice questions, set `multiple` to `true`.

The complete tool arguments must follow this structure:
```json
{
  "questions": [
    {
      "question": "The actual question to ask the user",
      "header": "Decision",
      "options": []
    }
  ]
}
```

## Free-form question example

Use this when the user needs to provide information that cannot be represented by predefined choices:
```json
{
  "questions": [
    {
      "question": "What behavior should the application implement?",
      "header": "Expected behavior",
      "options": []
    }
  ]
}
```
## Multiple-choice question example

Use this when the user must choose between predefined alternatives:

```json
{
  "questions": [
    {
      "question": "Which implementation approach should be used?",
      "header": "Implementation",
      "options": [
        {
          "label": "Approach A",
          "description": "First implementation strategy."
        },
        {
          "label": "Approach B",
          "description": "Alternative implementation strategy."
        }
      ],
      "multiple": false
    }
  ]
}
```

## Multiple independent questions

When several independent decisions are required, include them in the same `questions` array:

```json
{
  "questions": [
    {
      "question": "Which implementation approach should be used?",
      "header": "Implementation",
      "options": [
        {
          "label": "Approach A",
          "description": "First implementation strategy."
        },
        {
          "label": "Approach B",
          "description": "Alternative implementation strategy."
        }
      ],
      "multiple": false
    },
    {
      "question": "What should the feature be called?",
      "header": "Naming",
      "options": []
    }
  ]
}
```