FROM public.ecr.aws/lambda/python:3.11

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy worker scripts (all co-located in build context)
COPY fingerprint_worker.py  ${LAMBDA_TASK_ROOT}/fingerprint_worker.py
COPY api_caller_agent.py    ${LAMBDA_TASK_ROOT}/api_caller_agent.py
COPY doc_reader_agent.py    ${LAMBDA_TASK_ROOT}/doc_reader_agent.py

# Ensure Lambda runtime (non-root) can read all files
RUN chmod -R 755 ${LAMBDA_TASK_ROOT}

CMD ["fingerprint_worker.lambda_handler"]
