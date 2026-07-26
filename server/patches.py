# patches.py — совместимость PyTorch 2.6+ (weights_only) со старыми
# fairseq/HuBERT чекпоинтами. apply() должен быть вызван ДО импорта
# rvc_service (который тянет rvc_python -> fairseq).
#
# Начиная с PyTorch 2.6, torch.load() по умолчанию weights_only=True и
# отказывается грузить старые pickle-классы fairseq (например,
# fairseq.data.dictionary.Dictionary). HuBERT-модель (нужна RVC для
# извлечения признаков голоса) использует именно такой формат — без
# патча загрузка падает с UnpicklingError, а rvc-python эту ошибку
# проглатывает вместо явного показа, из-за чего вылезает малопонятная
# "'tuple' object has no attribute 'dtype'".
#
# Доверяем источнику файла (HuBERT — публичный общеиспользуемый чекпоинт),
# поэтому возвращаем старое поведение torch.load для всего процесса.

import torch

_original_torch_load = torch.load


def _patched_torch_load(*args, **kwargs):
    kwargs.setdefault("weights_only", False)
    return _original_torch_load(*args, **kwargs)


def apply():
    torch.load = _patched_torch_load
