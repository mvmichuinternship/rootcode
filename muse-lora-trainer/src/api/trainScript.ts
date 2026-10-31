/** Python entrypoint executed inside the Baseten training job. Configured through environment variables. */
export const TRAIN_SCRIPT = String.raw`"""LoRA/QLoRA SFT entrypoint executed inside the Baseten training job."""
import inspect
import json
import os

import torch
from datasets import load_dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

BASE_MODEL = os.environ["BASE_MODEL"]
RANK = int(os.environ.get("LORA_RANK", "16"))
ALPHA = int(os.environ.get("LORA_ALPHA", str(RANK * 2)))
LR = float(os.environ.get("LEARNING_RATE", "2e-4"))
EPOCHS = float(os.environ.get("EPOCHS", "3"))
MAX_LEN = int(os.environ.get("MAX_SEQ_LEN", "4096"))
QUANT4 = os.environ.get("LOAD_IN_4BIT", "true").lower() == "true"
OUT = os.environ.get("BT_CHECKPOINT_DIR", "/tmp/checkpoints")
HF_TOKEN = os.environ.get("HF_TOKEN") or None
HERE = os.path.dirname(os.path.abspath(__file__))
if not os.path.exists(os.path.join(HERE, "train.jsonl")):
    HERE = os.getcwd()


def to_messages(row):
    if row.get("messages"):
        return {"messages": row["messages"]}
    return {"messages": [{"role": "user", "content": row["prompt"]}, {"role": "assistant", "content": row["completion"]}]}


def load(name):
    path = os.path.join(HERE, name)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return None
    ds = load_dataset("json", data_files=path, split="train")
    return ds.map(to_messages, remove_columns=ds.column_names)


train = load("train.jsonl")
val = load("val.jsonl")
print(f"train={len(train)} val={len(val) if val else 0}", flush=True)

tok = AutoTokenizer.from_pretrained(BASE_MODEL, token=HF_TOKEN)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token

kwargs = dict(token=HF_TOKEN, torch_dtype=torch.bfloat16, device_map="auto")
if QUANT4:
    kwargs["quantization_config"] = BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True
    )
try:
    model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, **kwargs)
except ValueError:
    from transformers import AutoModelForImageTextToText
    model = AutoModelForImageTextToText.from_pretrained(BASE_MODEL, **kwargs)

names = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
is_multimodal = any("language_model" in n for n, _ in model.named_modules())
# For multimodal checkpoints only adapt the language model; the vision tower stays frozen.
target = r".*language_model.*\.(" + "|".join(names) + ")" if is_multimodal else names

peft_config = LoraConfig(r=RANK, lora_alpha=ALPHA, lora_dropout=0.05, target_modules=target, task_type="CAUSAL_LM")

params = inspect.signature(SFTConfig.__init__).parameters
cfg = dict(
    output_dir=OUT,
    num_train_epochs=EPOCHS,
    learning_rate=LR,
    per_device_train_batch_size=1,
    gradient_accumulation_steps=8,
    lr_scheduler_type="cosine",
    warmup_ratio=0.03,
    logging_steps=5,
    save_strategy="epoch",
    bf16=True,
    gradient_checkpointing=True,
    report_to="none",
)
cfg["max_length" if "max_length" in params else "max_seq_length"] = MAX_LEN
if val is not None:
    cfg["eval_strategy" if "eval_strategy" in params else "evaluation_strategy"] = "epoch"
    cfg["per_device_eval_batch_size"] = 1

trainer_kwargs = dict(model=model, args=SFTConfig(**cfg), train_dataset=train, eval_dataset=val, peft_config=peft_config)
trainer_params = inspect.signature(SFTTrainer.__init__).parameters
trainer_kwargs["processing_class" if "processing_class" in trainer_params else "tokenizer"] = tok
trainer = SFTTrainer(**trainer_kwargs)
trainer.train()
print(json.dumps({"done": True}), flush=True)
`;
